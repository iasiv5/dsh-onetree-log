/**
 * store.js — dump 持久化与生命周期。
 *
 * 目录布局（root 可用 ONETREE_LOG_DIR 覆盖）：
 *   <root>/dumps/<id>/archive/<原始文件名>   ← 上传的压缩包（open-path 登记的原地文件不复制）
 *   <root>/dumps/<id>/extracted/…            ← 解包产物（dump 根在其中或即为其本身）
 *   <root>/dumps/<id>/meta.json              ← 元数据
 *
 * id 形如 20260919-153012-ffdc_xxx（时间戳 + 归档名 slug），列表按 id 倒序即时间倒序。
 * meta 记录 sourceKind（upload | path-archive | path-dir）：path 类不拥有原文件，
 * 删除时只清本插件目录；dir 类连 extracted 也不删（用户自己的目录）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomBytes } from 'node:crypto'
import { extractAndDetect, detectDumpRoot } from './detect.js'
import { isArchive } from './extract.js'
import { buildInventory } from './inventory.js'

export function storeRoot() {
  return process.env.ONETREE_LOG_DIR ?? path.join(os.homedir(), '.local', 'share', 'dsh-onetree-log')
}

const slugify = name => String(name)
  .toLowerCase()
  .replace(/\.(tar\.gz|tar\.zst|tgz|tzst|tar|zip)$/i, '')
  .replace(/[^a-z0-9._-]+/g, '_')
  .replace(/^_+|_+$/g, '')
  .slice(0, 48) || 'dump'

const pad2 = n => String(n).padStart(2, '0')

function timestampId(date = new Date()) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`
    + `-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
    + `-${randomBytes(2).toString('hex')}`
}

export class DumpStore {
  constructor(root) {
    this.root = root ?? storeRoot()
    this.dumpsDir = path.join(this.root, 'dumps')
    this.cache = new Map() // id → meta
    this.reload()
  }

  reload() {
    this.cache.clear()
    fs.mkdirSync(this.dumpsDir, { recursive: true })
    for (const e of fs.readdirSync(this.dumpsDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const metaPath = path.join(this.dumpsDir, e.name, 'meta.json')
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
        if (meta?.id === e.name) this.cache.set(meta.id, meta)
      } catch { /* 半途中断的 ingest：目录在但 meta 缺失 → 视为空壳，保留待覆盖/删除 */ }
    }
  }

  list() {
    return [...this.cache.values()]
      .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .map(m => ({
        id: m.id, label: m.label, createdAt: m.createdAt, sourceKind: m.sourceKind,
        sourcePath: m.sourcePath ?? null, archiveName: m.archiveName ?? null,
        archiveSize: m.archiveSize ?? null, format: m.format ?? null,
        detected: { score: m.detected?.score ?? 0, markers: m.detected?.markers ?? { strong: [], medium: [] }, hint: m.detected?.hint ?? null },
        rootDir: m.rootDir,
      }))
  }

  get(id) {
    const key = String(id ?? '')
    // id 直接拼进文件系统路径：只放行时间戳-hex-slug 形态的安全字符
    if (!/^[0-9]{8}-[0-9]{6}-[a-f0-9]{4}-[a-z0-9._-]+$/.test(key)) return undefined
    return this.cache.get(key)
  }

  /** ingest 完成后的完整详情：meta + 现算的文件清单（带内存缓存）。 */
  detail(id) {
    const meta = this.get(id)
    if (!meta) return undefined
    const detail = { ...meta }
    try {
      detail.inventory = buildInventory(meta.rootDir)
    } catch (error) {
      detail.inventory = { files: [], stats: { sections: {}, totalFiles: 0, totalBytes: 0, knownFiles: 0, otherFiles: 0 }, tree: null, truncated: false, error: error.message }
    }
    return detail
  }

  /**
   * 登记一个压缩包（上传落盘的临时文件，或服务器本地路径）。
   * upload 模式会把 archive 移进自己的目录；path 模式原地引用。
   */
  async ingestArchive(archivePath, { sourceKind = 'upload', label } = {}) {
    const resolved = path.resolve(String(archivePath))
    if (!isArchive(resolved)) {
      throw new Error(`不是受支持的压缩包（.tar / .tar.gz / .tgz / .tar.zst / .tzst / .zip）: ${path.basename(resolved)}`)
    }
    const stat = fs.statSync(resolved)
    if (stat.size === 0) throw new Error('压缩包为空文件')
    const base = slugify(label ?? path.basename(resolved))
    const id = `${timestampId()}-${base}`
    const home = path.join(this.dumpsDir, id)
    fs.mkdirSync(home, { recursive: true })

    try {
      const detected = await extractAndDetect(resolved, home)
      let archiveName = path.basename(resolved)
      let archiveSize = stat.size
      if (sourceKind === 'upload') {
        const archiveHome = path.join(home, 'archive')
        fs.mkdirSync(archiveHome, { recursive: true })
        fs.renameSync(resolved, path.join(archiveHome, archiveName))
      }
      const meta = {
        id,
        label: label ?? path.basename(resolved),
        createdAt: new Date().toISOString(),
        sourceKind,
        sourcePath: sourceKind === 'upload' ? null : resolved,
        archiveName,
        archiveSize,
        format: null,
        detected: { score: detected.score, markers: detected.markers, hint: detected.hint },
        rootDir: detected.rootDir,
      }
      fs.writeFileSync(path.join(home, 'meta.json'), JSON.stringify(meta, null, 2))
      this.cache.set(id, meta)
      return meta
    } catch (error) {
      // 失败清理：不留半成品目录；upload 的临时文件也一并删除
      fs.rmSync(home, { recursive: true, force: true })
      if (sourceKind === 'upload') { try { fs.rmSync(resolved, { force: true }) } catch { /* ignore */ } }
      throw error
    }
  }

  /** 登记一个已解压的 dump 目录（不复制，原地分析；删除登记不删目录）。 */
  ingestDir(dirPath, { label } = {}) {
    const resolved = path.resolve(String(dirPath))
    if (!fs.statSync(resolved).isDirectory()) throw new Error('路径不是目录')
    const detected = detectDumpRoot(resolved)
    const id = `${timestampId()}-${slugify(label ?? path.basename(resolved))}`
    const home = path.join(this.dumpsDir, id)
    fs.mkdirSync(home, { recursive: true })
    const meta = {
      id,
      label: label ?? path.basename(resolved),
      createdAt: new Date().toISOString(),
      sourceKind: 'path-dir',
      sourcePath: resolved,
      archiveName: null,
      archiveSize: null,
      format: null,
      detected: { score: detected.score, markers: detected.markers, hint: detected.hint },
      rootDir: detected.rootDir,
    }
    fs.writeFileSync(path.join(home, 'meta.json'), JSON.stringify(meta, null, 2))
    this.cache.set(id, meta)
    return meta
  }

  /** 删除登记；只删自己拥有的数据（extracted + archive + meta）。 */
  remove(id) {
    const meta = this.get(id)
    if (!meta) return false
    // path-dir：rootDir 是用户目录，绝不能删；只清登记目录（里面只有 meta.json）
    const home = path.join(this.dumpsDir, id)
    if (meta.sourceKind === 'path-dir') {
      fs.rmSync(home, { recursive: true, force: true })
    } else {
      fs.rmSync(home, { recursive: true, force: true })
    }
    this.cache.delete(id)
    return true
  }

  /** 在 dump 根内安全解析相对路径（拒绝逃逸），返回绝对路径或抛错。 */
  resolveFile(id, relPath) {
    const meta = this.get(id)
    if (!meta) throw new Error('dump 不存在')
    const rel = String(relPath ?? '')
    if (rel.includes('..') || rel.startsWith('/') || rel.includes('\0')) {
      throw new Error('非法的文件路径')
    }
    const target = path.resolve(meta.rootDir, ...rel.split('/').filter(s => s !== '' && s !== '.'))
    const base = path.resolve(meta.rootDir)
    if (target !== base && !target.startsWith(base + path.sep)) throw new Error('非法的文件路径')
    return target
  }
}
