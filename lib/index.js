/**
 * dsh-onetree-log — host half.
 *
 * 在 DSH web 服务器上注册同源前缀路由 `/onetree-log*`：
 *   POST   /onetree-log/upload?name=<原文件名>      原始字节流上传（非 multipart，天然
 *                                                      流式落盘，上限 512MiB）→ 解包探测登记
 *   POST   /onetree-log/open-path  {path,label}       登记服务器本地压缩包或已解压 dump 目录
 *   GET    /onetree-log/dumps                        登记列表（时间倒序）
 *   GET    /onetree-log/dumps/<id>                   详情（meta + 文件清单/分类统计/树）
 *   GET    /onetree-log/dumps/<id>/file?path=<rel>   文件预览（文本前 256KiB；二进制探测）
 *   DELETE /onetree-log/dumps/<id>                   删除登记（path 类不动用户原文件/目录）
 *
 * 信任围栏与 @iasiv5/dsh-obmc-web 一致：Host 须 loopback 或部署信任域，
 * Sec-Fetch-Site 不得 cross-site，Origin 须同 Host 主机名。这不是认证——
 * 认证由部署在 GUI 前面的网关（dsh-auth-caddy 等）负责。
 *
 * 第二阶段扩展点：在 `/onetree-log/dumps/<id>/section/<name>` 上挂
 * 逐域解析器（sel/sensors/journal/…），见 lib/inventory.js 的 SECTIONS。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { DumpStore } from './store.js'

export const name = '@inventec/dsh-onetree-log'
export const inject = ['webServer', 'webRuntime']

const MAX_UPLOAD_BYTES = 512 * 1024 * 1024
const PREVIEW_BYTES = 256 * 1024
const JSON_BODY_LIMIT = 8192
const TMP_ROOT = () => path.join(store.dumpsDir, '.tmp-uploads')

let store = null

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > JSON_BODY_LIMIT) { reject(new Error('request body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

/** 上传字节流 → 临时文件（限额流式落盘，不进内存）。 */
async function saveUpload(req, destPath) {
  let received = 0
  const counter = new Readable().wrap(req) // 仅用于错误传播；直接流 req
  const out = fs.createWriteStream(destPath)
  await new Promise((resolve, reject) => {
    req.on('data', chunk => {
      received += chunk.length
      if (received > MAX_UPLOAD_BYTES) {
        reject(new Error(`上传超过 ${(MAX_UPLOAD_BYTES / 1024 / 1024).toFixed(0)}MiB 上限；超大日志请放到服务器本地后用「登记服务器路径」导入`))
        req.destroy()
        out.destroy()
        return
      }
      if (!out.write(chunk)) {
        req.pause()
        out.once('drain', () => req.resume())
      }
    })
    req.on('end', () => out.end(() => resolve()))
    req.on('error', reject)
    out.on('error', reject)
  })
  void counter
}

function sanitizeUploadName(raw) {
  const base = path.basename(String(raw ?? ''))
  if (base === '' || base === '.' || base === '..' || base.includes('/') || base.includes('\\') || base.includes('\0')) {
    throw new Error('非法的上传文件名')
  }
  return base.slice(0, 200)
}

// ── 信任围栏（与 dsh-obmc-web 同款） ─────────────────────────────────────

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function trustedRequest(req, trustedHosts) {
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  let hostUrl
  try { hostUrl = new URL(`http://${host}`) } catch { return false }
  const trusted = (trustedHosts ?? []).some(entry => {
    try {
      const entryUrl = new URL(`http://${entry}`)
      const withPort = entryUrl.port !== ''
      return withPort
        ? `${entryUrl.hostname}:${entryUrl.port}` === hostUrl.host
        : entryUrl.hostname === hostUrl.hostname
    } catch { return false }
  })
  if (!isLoopbackHostname(hostUrl.hostname) && !trusted) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch {
    return false
  }
}

// ── 文件预览 ─────────────────────────────────────────────────────────────

function looksBinary(buf) {
  const n = Math.min(buf.length, 2048)
  for (let i = 0; i < n; i += 1) {
    const b = buf[i]
    if (b === 0) return true
    if (b < 7 || (b > 13 && b < 32 && b !== 27)) return true
  }
  return false
}

function previewFile(absPath) {
  const stat = fs.statSync(absPath)
  if (!stat.isFile()) throw new Error('不是常规文件')
  const handle = fs.openSync(absPath, 'r')
  try {
    const len = Math.min(stat.size, PREVIEW_BYTES)
    const buf = Buffer.alloc(len)
    fs.readSync(handle, buf, 0, len, 0)
    if (looksBinary(buf)) {
      return { binary: true, size: stat.size, truncated: stat.size > len }
    }
    return {
      binary: false,
      size: stat.size,
      truncated: stat.size > len,
      content: buf.toString('utf8'),
    }
  } finally {
    fs.closeSync(handle)
  }
}

// ── 路由分发 ─────────────────────────────────────────────────────────────

async function dispatch(req, res, log) {
  const url = new URL(req.url ?? '/', 'http://dsh.internal')
  const parts = url.pathname.split('/').filter(Boolean) // ['onetree-log', ...]
  const method = req.method ?? 'GET'

  // GET /onetree-log/dumps
  if (parts[1] === 'dumps' && parts.length === 2) {
    if (method !== 'GET') return writeJson(res, 405, { error: 'method not allowed' })
    return writeJson(res, 200, { dumps: store.list() })
  }

  if (parts.length === 1 && parts[0] === 'onetree-log') {
    if (method !== 'GET') return writeJson(res, 405, { error: 'method not allowed' })
    return writeJson(res, 200, { dumps: store.list() })
  }

  if (parts[1] === 'dumps' && parts.length === 3) {
    const id = parts[2]
    if (method === 'GET') {
      const detail = store.detail(id)
      if (!detail) return writeJson(res, 404, { error: 'dump 不存在' })
      return writeJson(res, 200, detail)
    }
    if (method === 'DELETE') {
      return writeJson(res, store.remove(id) ? 200 : 404, { ok: true })
    }
    return writeJson(res, 405, { error: 'method not allowed' })
  }

  if (parts[1] === 'dumps' && parts[3] === 'file' && parts.length === 4) {
    if (method !== 'GET') return writeJson(res, 405, { error: 'method not allowed' })
    const rel = url.searchParams.get('path') ?? ''
    try {
      const abs = store.resolveFile(parts[2], rel)
      return writeJson(res, 200, previewFile(abs))
    } catch (error) {
      return writeJson(res, 400, { error: error.message })
    }
  }

  if (parts[1] === 'upload' && parts.length === 2) {
    if (method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
    const name = sanitizeUploadName(url.searchParams.get('name'))
    fs.mkdirSync(TMP_ROOT(), { recursive: true })
    const tmp = path.join(TMP_ROOT(), `${Date.now()}-${Math.random().toString(16).slice(2)}-${name}`)
    try {
      await saveUpload(req, tmp)
      const meta = await store.ingestArchive(tmp, { sourceKind: 'upload', label: name })
      log?.info?.(`[dsh-onetree-log] ingested upload ${meta.id} (${meta.detected.score} 分)`)
      return writeJson(res, 200, { ok: true, dump: { ...meta, rootDir: undefined } })
    } catch (error) {
      try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
      return writeJson(res, 400, { error: error.message })
    }
  }

  if (parts[1] === 'open-path' && parts.length === 2) {
    if (method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
    try {
      const body = await readJsonBody(req)
      const p = String(body.path ?? '').trim()
      if (p === '') return writeJson(res, 400, { error: 'path 不能为空' })
      const resolved = path.resolve(p)
      const stat = fs.statSync(resolved) // 不存在时抛错 → 400
      const label = String(body.label ?? path.basename(resolved)).slice(0, 200)
      const meta = stat.isDirectory()
        ? store.ingestDir(resolved, { label })
        : await store.ingestArchive(resolved, { sourceKind: 'path-archive', label })
      log?.info?.(`[dsh-onetree-log] ingested path ${meta.id} (${meta.sourceKind})`)
      return writeJson(res, 200, { ok: true, dump: { ...meta, rootDir: undefined } })
    } catch (error) {
      return writeJson(res, 400, { error: error.message })
    }
  }

  return writeJson(res, 404, { error: 'not found' })
}

export function apply(ctx) {
  store = new DumpStore()
  ctx.logger?.info?.(`[dsh-onetree-log] store at ${store.dumpsDir}，已登记 ${store.list().length} 个 dump`)

  const trustedHostsOf = () => (Array.isArray(ctx.webRuntime?.trustedHosts) ? ctx.webRuntime.trustedHosts : [])
  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/onetree-log',
      handler: (req, res) => {
        if (!trustedRequest(req, trustedHostsOf())) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('dsh-onetree-log: forbidden')
          return
        }
        dispatch(req, res, ctx.logger).catch(error => {
          ctx.logger?.warn?.(`[dsh-onetree-log] ${req.method} ${req.url} failed: ${error.message}`)
          try {
            if (!res.headersSent) writeJson(res, 500, { error: error.message })
            else res.end()
          } catch { /* socket gone */ }
        })
      },
    }), 'dsh-onetree-log: /onetree-log prefix')
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-onetree-log] skipped route registration: ${error.message}`)
  }
}
