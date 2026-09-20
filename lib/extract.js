/**
 * extract.js — 安全解包：OneTree 一键日志压缩包 → 目录。
 *
 * 设计参照 openUBMC bmcstudio_log_reviewer 的 archive.ts 思路（纯 JS tar 读取器，
 * 拒绝路径逃逸 / 符号链接 / 超限解压），并适配 OneTree 生态：
 *   - `.tar` / `.tar.gz` / `.tgz`：纯 JS 流式 tar 解析（ustar / pax / GNU longname）
 *   - `.tar.zst` / `.tzst`：Node ≥22.15 的 zlib zstd 流；无原生支持时回退系统 `zstd -dc`
 *   - `.zip`：系统 `unzip`（回退 `tar`），先列目校验再解压（execFile，无 shell）
 *
 * 防护：zip-slip（绝对路径 / `..` / NUL）、符号链接与硬链接直接拒绝、
 * 单文件 1GiB / 总量 2GiB / 条目数 20k 上限，超限立即中止并抛错。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { execFile, spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'

export const ARCHIVE_EXTS = ['.tar', '.tar.gz', '.tgz', '.tar.zst', '.tzst', '.zip']
export const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
export const DEFAULT_MAX_FILES = 20_000
const MAX_FILE_BYTES = 1024 * 1024 * 1024
const EXEC_OPTS = { maxBuffer: 64 * 1024 * 1024, timeout: 300_000 }

export function archiveFormat(p) {
  const lower = String(p).toLowerCase()
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz'
  if (lower.endsWith('.tar.zst') || lower.endsWith('.tzst')) return 'tar.zst'
  if (lower.endsWith('.tar')) return 'tar'
  if (lower.endsWith('.zip')) return 'zip'
  return null
}

export function isArchive(p) {
  return archiveFormat(p) !== null
}

// ── 路径安全（zip-slip 防护） ─────────────────────────────────────────────

function safeJoin(destDir, name) {
  const raw = String(name ?? '')
  if (raw.includes('\0')) throw new Error(`检测到不安全的归档条目（含 NUL）: ${raw}`)
  if (raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)) {
    throw new Error(`检测到不安全的归档条目（绝对路径）: ${raw}`)
  }
  const segments = raw.split(/[\\/]+/).filter(s => s !== '' && s !== '.')
  if (segments.includes('..')) throw new Error(`检测到不安全的归档条目（路径逃逸）: ${raw}`)
  if (segments.length === 0) throw new Error(`检测到空的归档条目名: ${raw}`)
  if (segments.some(s => s.length > 255)) throw new Error(`检测到超长条目名: ${raw.slice(0, 80)}…`)
  const target = path.resolve(destDir, ...segments)
  const base = path.resolve(destDir)
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`检测到不安全的归档条目（越界）: ${raw}`)
  }
  return target
}

// ── 纯 JS 流式 tar 解析（ustar / pax / GNU longname） ─────────────────────

function parseOctal(field) {
  const text = field.toString('latin1').replace(/[\0 ]/g, '')
  if (text === '') return 0
  const value = parseInt(text, 8)
  return Number.isNaN(value) ? 0 : value
}

/** 解析 pax 扩展头（`%d key=value\n` 记录序列），提取 path 等覆盖项。 */
function parsePax(buf) {
  const out = {}
  let offset = 0
  while (offset < buf.length) {
    const sp = buf.indexOf(' ', offset)
    if (sp < 0) break
    const len = parseInt(buf.subarray(offset, sp).toString('latin1'), 10)
    if (!Number.isFinite(len) || len <= 0 || offset + len > buf.length) break
    const record = buf.subarray(sp + 1, offset + len).toString('utf8')
    const eq = record.indexOf('=')
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1).replace(/\n$/, '')
    offset += len
  }
  return out
}

const padBytesFor = size => (512 - (size % 512)) % 512

/**
 * 从 tar 字节流解包到 destDir。流式消费（for-await 天然背压），文件内容
 * 逐段落盘，不整包进内存。truncated 归档 / 链接条目 / 越限均抛错。
 *
 * 状态机：header（512B 头）→ payload（size 字节）→ padding（512 对齐填充，
 * padRemain 显式记录，未到齐不会误当下一头）→ header …
 */
export async function extractTar(source, destDir, opts = {}) {
  const maxTotal = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES
  fs.mkdirSync(destDir, { recursive: true })

  let buf = Buffer.alloc(0)
  let total = 0
  let files = 0
  let pendingName = null // GNU 'L' 长文件名
  let paxPath = null // pax 'x' 的 path 覆盖
  let sawAny = false
  let done = false
  let payload = null // {kind,size,written,ws?,chunks?} | null=等 header
  let padRemain = 0 // 载荷后的对齐填充剩余字节
  const flushes = [] // 每个写流的 finished promise：返回前必须等全部落盘

  const take = n => { const out = buf.subarray(0, n); buf = buf.subarray(n); return out }

  /** 处理恰好一个 512B 头；返回 false 表示还差数据。 */
  function headerOne() {
    if (buf.length < 512) return false
    const header = take(512)
    if (header.every(b => b === 0)) { done = true; return false } // 结尾空块
    sawAny = true
    const size = parseOctal(header.subarray(124, 136))
    const typeflag = String.fromCharCode(header[156] || 0x30)
    let name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '')
    const magic = header.subarray(257, 263).toString('latin1')
    if (magic.startsWith('ustar')) {
      const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '')
      if (prefix !== '') name = `${prefix}/${name}`
    }
    if (pendingName !== null) { name = pendingName; pendingName = null }
    if (paxPath !== null) { name = paxPath; paxPath = null }

    if (typeflag === 'L') { payload = { kind: 'longname', size, written: 0, chunks: [] }; return true }
    if (typeflag === 'K' || typeflag === 'g') { payload = { kind: 'skip', size, written: 0 }; return true }
    if (typeflag === 'x') { payload = { kind: 'pax', size, written: 0, chunks: [] }; return true }
    if (typeflag === '1' || typeflag === '2') {
      throw new Error(`检测到链接条目（${typeflag === '2' ? '符号链接' : '硬链接'}），已拒绝: ${name}`)
    }
    if (typeflag === '5' || name.endsWith('/')) {
      if (name !== '' && name !== './') fs.mkdirSync(safeJoin(destDir, name), { recursive: true })
      if (++files > maxFiles) throw new Error(`归档条目数超过上限 ${maxFiles}`)
      return true
    }
    if (typeflag === '0' || typeflag === '\0' || typeflag === '7') {
      if (size > MAX_FILE_BYTES) throw new Error(`单文件超过 1GiB 上限: ${name}`)
      total += size
      if (total > maxTotal) throw new Error(`解压总量超过上限 ${(maxTotal / 1024 / 1024).toFixed(0)}MiB`)
      if (++files > maxFiles) throw new Error(`归档条目数超过上限 ${maxFiles}`)
      const target = safeJoin(destDir, name)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      if (size === 0) { fs.writeFileSync(target, Buffer.alloc(0)); return true }
      const ws = fs.createWriteStream(target)
      flushes.push(finished(ws))
      payload = { kind: 'file', size, written: 0, ws }
      return true
    }
    // 其余类型（设备/FIFO 等）：跳过载荷
    if (size === 0) return true
    payload = { kind: 'skip', size, written: 0 }
    return true
  }

  /** 载荷推进一档；返回 false 表示还需更多数据（pump 须退出等下一块）。 */
  function payloadStep() {
    if (buf.length === 0) return false
    const need = payload.size - payload.written
    const give = take(Math.min(need, buf.length))
    payload.written += give.length
    if (payload.kind === 'file') payload.ws.write(give)
    else if (payload.kind === 'longname' || payload.kind === 'pax') payload.chunks.push(give)
    if (payload.written < payload.size) return false

    const { kind, size, ws, chunks } = payload
    if (kind === 'file') ws.end()
    else if (kind === 'longname') {
      pendingName = Buffer.concat(chunks).toString('utf8').replace(/\0.*$/s, '').trim()
    } else if (kind === 'pax') {
      const overrides = parsePax(Buffer.concat(chunks))
      if (typeof overrides.path === 'string' && overrides.path !== '') paxPath = overrides.path
    }
    payload = null
    padRemain = padBytesFor(size)
    return true
  }

  let pumpIters = 0
  function pump() {
    for (;;) {
      if (++pumpIters > 5_000_000) {
        throw new Error(`tar 解析状态机失控（迭代超限）：state=${payload?.kind ?? 'header'} written=${payload?.written} size=${payload?.size} padRemain=${padRemain} bufLen=${buf.length} done=${done}`)
      }
      if (done) return
      if (padRemain > 0) {
        if (buf.length === 0) return
        const eat = Math.min(padRemain, buf.length)
        take(eat)
        padRemain -= eat
        continue
      }
      if (payload === null) {
        if (!headerOne()) return
        continue
      }
      if (!payloadStep()) return
    }
  }

  let backpressure = null
  for await (const chunk of source) {
    if (done) break
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
    try {
      pump()
    } catch (error) {
      if (payload?.kind === 'file') payload.ws.destroy()
      throw error
    }
    while (backpressure) { await backpressure; backpressure = null }
    if (payload?.kind === 'file') {
      const ws = payload.ws
      if (ws.writableLength > 1 << 20) {
        backpressure = new Promise(resolve => ws.once('drain', resolve))
      }
    }
  }
  if (payload !== null) {
    if (payload.kind === 'file') payload.ws.end()
    throw new Error('归档在条目载荷中途结束（文件损坏或下载不完整）')
  }
  if (!sawAny) throw new Error('不是有效的 tar 归档（未发现任何条目头）')
  // 所有写流真正落盘后才算解包完成（end() 只入队，flush 是异步的）
  await Promise.all(flushes)
}

// ── zip（系统工具，execFile 无 shell） ─────────────────────────────────────

function execFilePromise(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, EXEC_OPTS, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr: String(stderr || '') }))
      else resolve(String(stdout))
    })
  })
}

function assertSafeEntryNames(listing) {
  for (const raw of listing.split('\n')) {
    const name = raw.trim()
    if (!name) continue
    if (name.startsWith('/') || name.split(/[\\/]+/).includes('..') || name.includes('\0')) {
      throw new Error(`检测到不安全的归档条目（路径逃逸）: ${name}`)
    }
  }
}

async function extractZip(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true })
  let listing
  try {
    listing = await execFilePromise('unzip', ['-Z1', archivePath])
  } catch (eUnzip) {
    try {
      listing = await execFilePromise('tar', ['-tf', archivePath])
    } catch {
      throw new Error(`无法读取 zip 包（需要系统 unzip 或 tar）: ${eUnzip.message}`)
    }
    assertSafeEntryNames(listing)
    await execFilePromise('tar', ['-xf', archivePath, '-C', destDir])
    return
  }
  assertSafeEntryNames(listing)
  await execFilePromise('unzip', ['-o', '-q', archivePath, '-d', destDir])
}

// ── 入口 ─────────────────────────────────────────────────────────────────

/** zlib 是否带原生 zstd 流（Node ≥22.15）。 */
function zstdDecodeStream(archivePath) {
  if (typeof zlib.createZstdDecompress === 'function') return null // 由调用方 pipe
  // 回退：系统 zstd -dc 的 stdout 包成 Readable
  const child = spawn('zstd', ['-dc', String(archivePath)], { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stderr.resume()
  child.on('error', () => {}); // 流错误经 stdout 'error' 传出
  return Readable.from(child.stdout)
}

/**
 * 解包 OneTree 一键日志压缩包到 destDir（应为空目录）。
 * 返回 { format }；不支持的扩展名 / 解包失败 / 安全违规均抛错。
 */
export async function extractArchive(archivePath, destDir, opts = {}) {
  const format = archiveFormat(archivePath)
  if (format === null) {
    throw new Error(`不支持的压缩格式（支持 ${ARCHIVE_EXTS.join(' / ')}）: ${path.basename(archivePath)}`)
  }
  if (format === 'zip') {
    await extractZip(String(archivePath), destDir)
    return { format }
  }
  let stream
  if (format === 'tar.zst') {
    const fallback = zstdDecodeStream(archivePath)
    if (fallback) {
      stream = fallback
    } else {
      stream = fs.createReadStream(String(archivePath)).pipe(zlib.createZstdDecompress())
    }
  } else {
    stream = fs.createReadStream(String(archivePath))
    if (format === 'tar.gz') stream = stream.pipe(zlib.createGunzip())
  }
  await extractTar(stream, destDir, opts)
  return { format }
}
