/**
 * detect.js — OneTree 一键日志（OpenBMC dreport dump）探测。
 *
 * OneTree 是 AMI 的 OpenBMC 商业发行版，其"一键日志"由 phosphor-debug-collector
 * （dreport）产出：一组扁平的 *.log 文件（ipmitool/journalctl/busctl 等命令输出）。
 * 本模块在解包后的目录树里按"标记文件评分"定位 dump 根：
 *   - 强标记（dreport 专属）：selinfo.log / sensorinfo.log / journal-pretty.log … 每个 +3
 *   - 中标记（通用 OpenBMC 采集项）：dmesg.log / fru-info.log / inventory.log … 每个 +1
 *   - 分数 ≥3 判定为 OneTree dump
 *
 * 兼容两种常见包装：
 *   1. 外层包直接就是 dump 文件集（根即 dump 根）
 *   2. 外层包里嵌着内层压缩包（OEM 常见 zip 套 tar）→ 唯一压缩包时自动解一层（≤2 层）
 *
 * 另附 SP-X FFDC 血统标记（sulist / nvram / sensor_data 等），仅作提示——
 * 命中说明用户上传的是老 SP-X FFDC 而非 OneTree dump，错误信息里指出来。
 */
import fs from 'node:fs'
import path from 'node:path'
import { extractArchive, isArchive } from './extract.js'

export const STRONG_MARKERS = [
  'selinfo.log', 'sensorinfo.log', 'sensor-readings.log', 'journal-pretty.log',
  'dreport.log', 'dreport_cmdfailure.log', 'dreport.cfg', 'elogall.log',
  'biospostcode.log', 'obmc-console.log', 'journalctl.log',
]
export const MEDIUM_MARKERS = [
  'dmesg.log', 'fru-info.log', 'inventory.log', 'fw-version.log', 'fw-printenv.log',
  'failed-services.log', 'pslist.log', 'top.log', 'hwmon.log', 'summary.log',
  'em-system.json', 'bmc-state.log', 'host-state.log', 'chassis-state.log',
  'cpuinfo', 'meminfo', 'uptime.log', 'network.log', 'netstat.log', 'iproute.log',
  'kernalringbuff.log', 'kernelringbuff.log', 'bios.log', 'boot-progress-info.log',
]
export const SPX_MARKERS = [
  'sulist', 'nvram', 'sensor_data', 'sel_data', 'all_sel_info', 'ipmi_log',
  'confblob', 'ami_info', 'bmc_data',
]

const WALK_MAX_ENTRIES = 20_000
const NESTED_DEPTH = 2

function listDirSafe(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * 扫描目录树，返回 { perDir: Map<dir, {score, strong[], medium[], spx[]}>, files: [{dir,name,size}] }。
 */
function scanTree(rootDir) {
  const perDir = new Map()
  const files = []
  let entries = 0
  const walk = dir => {
    for (const e of listDirSafe(dir)) {
      if (++entries > WALK_MAX_ENTRIES) return
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        walk(full)
      } else if (e.isFile()) {
        const known = STRONG_MARKERS.includes(e.name) ? 'strong'
          : MEDIUM_MARKERS.includes(e.name) ? 'medium'
          : SPX_MARKERS.includes(e.name.toLowerCase()) ? 'spx' : null
        let size = 0
        try { size = fs.statSync(full).size } catch { /* ignore */ }
        files.push({ dir, name: e.name, size, known })
        if (known) {
          let slot = perDir.get(dir)
          if (!slot) { slot = { score: 0, strong: [], medium: [], spx: [] }; perDir.set(dir, slot) }
          slot[known === 'spx' ? 'spx' : known].push(e.name)
          if (known === 'strong') slot.score += 3
          else if (known === 'medium') slot.score += 1
        }
      }
    }
  }
  walk(rootDir)
  return { perDir, files }
}

/** 从 perDir 里选 dump 根：分数最高者；平分取最深（最贴近文件集本身）。 */
function pickRoot(rootDir, perDir) {
  let best = null
  for (const [dir, slot] of perDir) {
    if (slot.score < 3) continue
    const depth = dir.split(path.sep).length
    if (best === null || slot.score > best.slot.score
      || (slot.score === best.slot.score && depth > best.depth)) {
      best = { dir, slot, depth }
    }
  }
  return best
}

function topEntries(dir, limit = 15) {
  try {
    return fs.readdirSync(dir).slice(0, limit)
  } catch {
    return []
  }
}

/**
 * 探测 OneTree dump 根目录。
 * 返回 { rootDir, score, markers: {strong, medium}, hint }；
 * 未识别时抛错（错误信息包含顶层内容与 SP-X 提示，便于用户判断）。
 */
export function detectDumpRoot(extractDir) {
  const { perDir, files } = scanTree(extractDir)
  const best = pickRoot(extractDir, perDir)
  if (best) {
    return {
      rootDir: best.dir,
      score: best.slot.score,
      markers: { strong: best.slot.strong, medium: best.slot.medium },
      hint: null,
    }
  }
  const spxHit = files.filter(f => f.known === 'spx').map(f => f.name)
  if (spxHit.length > 0) {
    const err = new Error('这更像 AMI MegaRAC SP-X 的 FFDC 日志（未发现 OneTree/OpenBMC dreport 标记文件，但发现 ' + spxHit.slice(0, 5).join(', ') + '）。本插件第一阶段只支持 OneTree（OpenBMC dreport）一键日志。')
    err.code = 'SPX_NOT_ONETREE'
    throw err
  }
  const err = new Error('未找到 OneTree 一键日志标记文件（如 selinfo.log / journal-pretty.log / dmesg.log）。顶层内容: ' + topEntries(extractDir).join(', '))
  err.code = 'NOT_ONETREE'
  err.topEntries = topEntries(extractDir)
  throw err
}

/**
 * 判断目录是否"只有一个压缩包值得展开"（嵌套包装场景）。
 * 返回该压缩包路径或 null。
 */
function soleNestedArchive(extractDir, files) {
  const archives = files.filter(f => isArchive(f.name))
  const others = files.filter(f => !isArchive(f.name))
  if (archives.length === 1 && others.length === 0) {
    return path.join(archives[0].dir, archives[0].name)
  }
  return null
}

/**
 * 解包 + 探测一体：处理嵌套包装（zip 套 tar 等，≤NESTED_DEPTH 层）。
 * 返回 detectDumpRoot 的结果；每层解到 extractDir 下的子目录。
 */
export async function extractAndDetect(archivePath, extractDir, opts = {}) {
  let currentArchive = archivePath
  let currentDir = extractDir
  for (let depth = 0; depth < NESTED_DEPTH; depth += 1) {
    const innerDir = path.join(currentDir, '__extracted')
    await extractArchive(currentArchive, innerDir, opts)
    const { perDir, files } = scanTree(innerDir)
    const best = pickRoot(innerDir, perDir)
    if (best) {
      return {
        rootDir: best.dir,
        score: best.slot.score,
        markers: { strong: best.slot.strong, medium: best.slot.medium },
        hint: depth > 0 ? `嵌套包装已自动展开 ${depth} 层` : null,
      }
    }
    const nested = soleNestedArchive(innerDir, files)
    if (nested === null) {
      // 不是嵌套包装：用统一入口报错（带 SP-X 提示）
      detectDumpRoot(innerDir)
      return // unreachable: detectDumpRoot 必抛错
    }
    currentArchive = nested
    currentDir = innerDir
  }
  const err = new Error(`嵌套压缩包超过 ${NESTED_DEPTH} 层，放弃展开`)
  err.code = 'TOO_NESTED'
  throw err
}
