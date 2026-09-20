/**
 * inventory.js — dump 文件清单与基础分类。
 *
 * 第二阶段逐域解析的基石：把 dump 根目录走一遍，产出
 *   - files[]：每个文件的相对路径 / 大小 / 所属 section（域）
 *   - stats：按 section 聚合（文件数 / 字节数），+ 总量与截断标记
 *   - tree：嵌套目录树（供前端渲染）
 *
 * section 划分与《OneTree 一键日志分析方案》P1 报告 §4.3 对齐；
 * KNOWN 表是"文件名 → section"的映射，第二阶段的解析器（sel/sensors/journal…）
 * 直接按 section 挂到对应文件集上，未识别文件归入 other，不丢失。
 */
import fs from 'node:fs'
import path from 'node:path'

export const SECTIONS = {
  overview: { label: '概览', color: '#8b9cf7' },
  sel: { label: 'SEL 事件', color: '#f87171' },
  sensors: { label: '传感器', color: '#fbbf24' },
  elog: { label: 'phosphor 事件', color: '#fb923c' },
  journal: { label: '系统日志', color: '#60a5fa' },
  inventory: { label: 'FRU/库存', color: '#34d399' },
  services: { label: '服务/进程', color: '#a78bfa' },
  boot: { label: '启动', color: '#f472b6' },
  thermal: { label: '温度/风扇', color: '#fdba74' },
  power: { label: '电源', color: '#facc15' },
  network: { label: '网络', color: '#22d3ee' },
  versions: { label: '版本', color: '#94a3b8' },
  console: { label: '串口控制台', color: '#e879f9' },
  other: { label: '其他', color: '#9ca3af' },
}

/** 文件名（basename）→ section 的已知映射。第二阶段在此表中追加即可。 */
export const KNOWN_FILES = {
  // overview
  'summary.log': 'overview', 'em-system.json': 'overview', 'bmc-state.log': 'overview',
  'host-state.log': 'overview', 'chassis-state.log': 'overview', 'settings.log': 'overview',
  'uptime.log': 'overview', 'os-release': 'overview', 'timedate.log': 'overview',
  // sel
  'selinfo.log': 'sel', 'selinfo': 'sel', 'ipmitool_sel_list.log': 'sel',
  // sensors
  'sensorinfo.log': 'sensors', 'sensor-readings.log': 'sensors', 'hwmon.log': 'thermal',
  // elog
  'elogall.log': 'elog', 'eventlog.log': 'elog',
  // journal
  'journal-pretty.log': 'journal', 'journalctl.log': 'journal', 'journal.log': 'journal',
  'dmesg.log': 'journal', 'kernalringbuff.log': 'journal', 'kernelringbuff.log': 'journal',
  'kernalcmdline.log': 'journal', 'kernlcmdline.log': 'journal',
  // inventory
  'fru-info.log': 'inventory', 'inventory.log': 'inventory', 'fru_info.txt': 'inventory',
  // services
  'failed-services.log': 'services', 'pslist.log': 'services', 'top.log': 'services',
  'freemem.log': 'services', 'meminfo': 'services', 'cpuinfo': 'services',
  'slabinfo.log': 'services', 'softirqs.log': 'services', 'interrupts.log': 'services',
  'lsof.log': 'services', 'varfilelist.log': 'services', 'tmpfilelist.log': 'services',
  'disk-usage.log': 'services', 'mntinfo.log': 'services', 'dreport.log': 'services',
  // boot
  'biospostcode.log': 'boot', 'boot-progress-info.log': 'boot', 'fw-printenv.log': 'boot',
  'bios.log': 'boot',
  // thermal
  'thermal_info.log': 'thermal', 'fan_info.log': 'thermal', 'faninfo.log': 'thermal',
  // power
  'power_statistics.csv': 'power', 'psu_info.log': 'power', 'psuinfo.log': 'power',
  'powerinfo.log': 'power',
  // network
  'network.log': 'network', 'netstat.log': 'network', 'iproute.log': 'network',
  'ipaddr.log': 'network', 'iplink.log': 'network', 'arptable.log': 'network',
  'routeinfo.log': 'network', 'networkrouteinfo.log': 'network', 'networkconfig.log': 'network',
  'arpcntlconf.log': 'network', 'channelconfig.log': 'network', 'channelaccess.log': 'network',
  // versions
  'fw-version.log': 'versions', 'app_revision.txt': 'versions', 'package_info': 'versions',
  'version_info.log': 'versions',
  // console
  'obmc-console.log': 'console', 'dpu_console': 'console', 'console.log': 'console',
}

const WALK_MAX = 20_000

function classify(basename) {
  if (Object.prototype.hasOwnProperty.call(KNOWN_FILES, basename)) {
    return { section: KNOWN_FILES[basename], known: true }
  }
  return { section: 'other', known: false }
}

/**
 * 构建 dump 清单。返回：
 * { files: [{path, name, size, section, known}], stats, tree, truncated }
 */
export function buildInventory(rootDir, { maxFiles = 10_000 } = {}) {
  const files = []
  const stats = { sections: {}, totalFiles: 0, totalBytes: 0, knownFiles: 0, otherFiles: 0 }
  let truncated = false
  let walked = 0

  const bump = (section, size, known) => {
    const s = stats.sections[section] ?? (stats.sections[section] = { count: 0, bytes: 0, label: SECTIONS[section]?.label ?? section })
    s.count += 1
    s.bytes += size
    stats.totalFiles += 1
    stats.totalBytes += size
    if (known) stats.knownFiles += 1
    else stats.otherFiles += 1
  }

  const walk = (dir, rel) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of entries) {
      if (++walked > WALK_MAX) { truncated = true; return }
      if (files.length >= maxFiles) { truncated = true; return }
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) {
        files.push({ path: childRel, name: e.name, size: 0, dir: true, section: null, known: false })
        walk(path.join(dir, e.name), childRel)
      } else if (e.isFile()) {
        let size = 0
        try { size = fs.statSync(path.join(dir, e.name)).size } catch { /* ignore */ }
        const { section, known } = classify(e.name)
        files.push({ path: childRel, name: e.name, size, dir: false, section, known })
        bump(section, size, known)
      }
    }
  }
  walk(rootDir, '')

  return { files, stats, tree: buildTree(files), truncated }
}

/** files[] → 嵌套树（目录含 size 汇总）。 */
export function buildTree(files) {
  const root = { name: '', dir: true, children: new Map(), size: 0, fileCount: 0 }
  for (const f of files) {
    const segments = f.path.split('/')
    let node = root
    for (let i = 0; i < segments.length; i += 1) {
      const name = segments[i]
      const isLeaf = i === segments.length - 1
      if (isLeaf && !f.dir) {
        node.children.set(name, { name, dir: false, size: f.size, section: f.section, known: f.known })
        let up = node
        while (up) { up.size += f.size; up.fileCount += 1; up = up.parent }
      } else {
        if (!node.children.has(name)) {
          const child = { name, dir: true, children: new Map(), size: 0, fileCount: 0, parent: node }
          node.children.set(name, child)
        }
        node = node.children.get(name)
      }
    }
  }
  const shape = node => {
    if (!node.dir) {
      return { name: node.name, dir: false, size: node.size, section: node.section, known: node.known }
    }
    const children = [...node.children.values()].sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1
      return a.name.localeCompare(b.name)
    }).map(shape)
    const out = { name: node.name, dir: true, size: node.size, fileCount: node.fileCount }
    if (children.length > 0) out.children = children
    return out
  }
  return shape(root)
}
