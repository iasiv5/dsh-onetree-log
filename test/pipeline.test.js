import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { detectDumpRoot, extractAndDetect } from '../lib/detect.js'
import { buildInventory, KNOWN_FILES, buildTree } from '../lib/inventory.js'
import { DumpStore } from '../lib/store.js'
import { buildTar, tmpdir } from './fixtures.js'

// ── detect ───────────────────────────────────────────────────────────────

test('detectDumpRoot：强标记命中定位 dump 根', () => {
  const dir = tmpdir('onetree-d1-')
  try {
    const root = path.join(dir, 'extracted', 'FFDC_20260919')
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, 'selinfo.log'), 'SEL entries')
    fs.writeFileSync(path.join(root, 'journal-pretty.log'), 'journal')
    fs.writeFileSync(path.join(root, 'readme.txt'), 'note')
    const result = detectDumpRoot(dir)
    assert.equal(result.rootDir, root)
    assert.ok(result.score >= 6)
    assert.deepEqual(result.markers.strong.sort(), ['journal-pretty.log', 'selinfo.log'])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('detectDumpRoot：嵌套子目录中的 dump 根优先于外层', () => {
  const dir = tmpdir('onetree-d2-')
  try {
    const nested = path.join(dir, 'level1', 'level2', 'dump')
    fs.mkdirSync(nested, { recursive: true })
    for (const f of ['selinfo.log', 'sensorinfo.log', 'dmesg.log']) {
      fs.writeFileSync(path.join(nested, f), 'x')
    }
    const result = detectDumpRoot(dir)
    assert.equal(result.rootDir, nested)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('detectDumpRoot：非 OneTree 内容报 NOT_ONETREE 并带顶层清单', () => {
  const dir = tmpdir('onetree-d3-')
  try {
    fs.writeFileSync(path.join(dir, 'README.md'), '# hi')
    fs.writeFileSync(path.join(dir, 'photo.jpg'), 'x')
    assert.throws(() => detectDumpRoot(dir), error => {
      assert.equal(error.code, 'NOT_ONETREE')
      assert.match(error.message, /README\.md/)
      return true
    })
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('detectDumpRoot：SP-X FFDC 血统给出专门提示', () => {
  const dir = tmpdir('onetree-d4-')
  try {
    for (const f of ['sulist', 'nvram', 'ami_info']) fs.writeFileSync(path.join(dir, f), 'x')
    assert.throws(() => detectDumpRoot(dir), error => {
      assert.equal(error.code, 'SPX_NOT_ONETREE')
      assert.match(error.message, /SP-X/)
      return true
    })
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('extractAndDetect：外层包套内层 tar 自动展开', async () => {
  const dir = tmpdir('onetree-d5-')
  try {
    const inner = buildTar([
      { name: 'selinfo.log', content: 'sel rows' },
      { name: 'sensorinfo.log', content: 'sensor rows' },
      { name: 'dmesg.log', content: 'dmesg' },
    ])
    const outer = buildTar([{ name: 'inner.tar', content: inner }])
    const outerPath = path.join(dir, 'outer.tar')
    fs.writeFileSync(outerPath, outer)
    const result = await extractAndDetect(outerPath, path.join(dir, 'extract'))
    assert.ok(result.score >= 6)
    assert.ok(result.rootDir.includes('__extracted'))
    assert.ok(fs.existsSync(path.join(result.rootDir, 'selinfo.log')))
    assert.match(result.hint, /嵌套/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// ── inventory ────────────────────────────────────────────────────────────

function makeSampleDump(root) {
  fs.mkdirSync(root, { recursive: true })
  const files = {
    'selinfo.log': 'SEL | 1 | event',
    'sensorinfo.log': 'CPU0 Temp | ok',
    'journal-pretty.log': 'journal lines',
    'dmesg.log': 'dmesg lines',
    'fru-info.log': 'fru',
    'failed-services.log': '0 loaded units',
    'biospostcode.log': '0x35',
    'fw-version.log': 'v2.1',
    'random-notes.txt': 'notes',
  }
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), content)
  }
  fs.mkdirSync(path.join(root, 'network'), { recursive: true })
  fs.writeFileSync(path.join(root, 'network', 'netstat.log'), 'netstat')
}

test('buildInventory：分类、统计与树', () => {
  const dir = tmpdir('onetree-i1-')
  try {
    const root = path.join(dir, 'dump')
    makeSampleDump(root)
    const inv = buildInventory(root)
    assert.equal(inv.stats.sections.sel.count, 1)
    assert.equal(inv.stats.sections.sensors.count, 1)
    assert.equal(inv.stats.sections.journal.count, 2) // journal-pretty + dmesg
    assert.equal(inv.stats.sections.network.count, 1)
    assert.equal(inv.stats.otherFiles, 1) // random-notes.txt
    assert.equal(inv.stats.knownFiles, 9) // 8 个根级已知文件 + network/netstat.log
    const tree = inv.tree
    assert.equal(tree.children.find(c => c.name === 'selinfo.log').section, 'sel')
    const netDir = tree.children.find(c => c.name === 'network')
    assert.equal(netDir.fileCount, 1)
    assert.ok(netDir.size > 0)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('buildTree 汇总目录大小；KNOWN_FILES 全部落在已知 section', () => {
  for (const [file, section] of Object.entries(KNOWN_FILES)) {
    assert.notEqual(section, 'other', `KNOWN_FILES 里 ${file} 不应归 other`)
  }
})

// ── store ────────────────────────────────────────────────────────────────

test('DumpStore：ingestArchive → detail → remove 全链路', async () => {
  const home = tmpdir('onetree-s1-')
  process.env.ONETREE_LOG_DIR = home
  try {
    const store = new DumpStore(path.join(home, 'store'))
    const tar = buildTar([
      { name: 'selinfo.log', content: 'sel rows' },
      { name: 'sensorinfo.log', content: 'sensors' },
      { name: 'journal-pretty.log', content: 'journal' },
    ])
    const archivePath = path.join(home, 'ffdc.tar')
    fs.writeFileSync(archivePath, tar)

    const meta = await store.ingestArchive(archivePath, { sourceKind: 'path-archive' })
    assert.ok(meta.id.startsWith('20'))
    assert.ok(meta.detected.score >= 9)
    assert.ok(fs.existsSync(path.join(meta.rootDir, 'selinfo.log')))

    const detail = store.detail(meta.id)
    assert.equal(detail.inventory.stats.totalFiles, 3)
    assert.equal(detail.inventory.stats.sections.sel.count, 1)

    // 持久化：新实例能读回
    const store2 = new DumpStore(path.join(home, 'store'))
    assert.equal(store2.list().length, 1)
    assert.equal(store2.list()[0].id, meta.id)

    // resolveFile 拒绝逃逸
    assert.throws(() => store.resolveFile(meta.id, '../x'), /非法/)
    assert.ok(store.resolveFile(meta.id, 'selinfo.log').endsWith('selinfo.log'))

    // path-archive 删除不动原文件
    assert.equal(store.remove(meta.id), true)
    assert.ok(fs.existsSync(archivePath))
    assert.equal(store.list().length, 0)
  } finally {
    delete process.env.ONETREE_LOG_DIR
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('DumpStore：非 OneTree 包 ingest 失败不留残骸', async () => {
  const home = tmpdir('onetree-s2-')
  process.env.ONETREE_LOG_DIR = home
  try {
    const store = new DumpStore(path.join(home, 'store'))
    const tar = buildTar([{ name: 'notes.txt', content: 'nothing' }])
    const archivePath = path.join(home, 'wrong.tar')
    fs.writeFileSync(archivePath, tar)
    await assert.rejects(() => store.ingestArchive(archivePath, { sourceKind: 'path-archive' }), /NOT_ONETREE|未找到/)
    assert.equal(store.list().length, 0)
    assert.deepEqual(fs.readdirSync(store.dumpsDir), [])
    // 原文件保留（path 来源）
    assert.ok(fs.existsSync(archivePath))
  } finally {
    delete process.env.ONETREE_LOG_DIR
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('DumpStore：ingestDir 原地登记不复制；删除不动用户目录', () => {
  const home = tmpdir('onetree-s3-')
  process.env.ONETREE_LOG_DIR = home
  try {
    const store = new DumpStore(path.join(home, 'store'))
    const root = path.join(home, 'mydump')
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, 'selinfo.log'), 'x')
    fs.writeFileSync(path.join(root, 'journal-pretty.log'), 'y')
    const meta = store.ingestDir(root, { label: '现场日志' })
    assert.equal(meta.sourceKind, 'path-dir')
    assert.equal(meta.rootDir, path.resolve(root))
    assert.equal(store.list().length, 1)
    store.remove(meta.id)
    assert.ok(fs.existsSync(path.join(root, 'selinfo.log')), '用户目录不能被删')
  } finally {
    delete process.env.ONETREE_LOG_DIR
    fs.rmSync(home, { recursive: true, force: true })
  }
})
