import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { Readable } from 'node:stream'
import { extractTar, extractArchive, isArchive, archiveFormat } from '../lib/extract.js'
import { buildTar, tmpdir } from './fixtures.js'

// ── 用例 ─────────────────────────────────────────────────────────────────

test('archiveFormat 识别受支持扩展名', () => {
  assert.equal(archiveFormat('FFDC_2026.tar.zst'), 'tar.zst')
  assert.equal(archiveFormat('dump.tgz'), 'tar.gz')
  assert.equal(archiveFormat('dump.tar.gz'), 'tar.gz')
  assert.equal(archiveFormat('dump.tar'), 'tar')
  assert.equal(archiveFormat('dump.zip'), 'zip')
  assert.equal(archiveFormat('dump.rar'), null)
  assert.equal(isArchive('dump.rar'), false)
})

test('纯 tar：多文件 + 子目录内容逐字节还原', async () => {
  const dir = tmpdir('onetree-t1-')
  try {
    const c1 = Buffer.from('SEL | 2026-09-19 | Platform alert\n')
    const big = Buffer.alloc(300 * 1024)
    for (let i = 0; i < big.length; i += 64) big.write('x'.repeat(64), i)
    const tar = buildTar([
      { name: 'selinfo.log', content: c1 },
      { name: 'sub/dir/journal-pretty.log', content: big },
    ])
    const slow = Readable.from((function* () {
      for (let i = 0; i < tar.length; i += 100) yield tar.subarray(i, i + 100)
    })())
    const out = path.join(dir, 'out')
    await extractTar(slow, out)
    assert.ok(fs.readFileSync(path.join(out, 'selinfo.log')).equals(c1))
    assert.ok(fs.readFileSync(path.join(out, 'sub/dir/journal-pretty.log')).equals(big))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('tar.gz / tar.zst 经 extractArchive 还原（zlib 原生 zstd）', async () => {
  const dir = tmpdir('onetree-t2-')
  try {
    const content = Buffer.from('journal line\n'.repeat(100))
    const tar = buildTar([{ name: 'journal-pretty.log', content }])
    const gz = path.join(dir, 'a.tar.gz')
    const zst = path.join(dir, 'a.tar.zst')
    fs.writeFileSync(gz, zlib.gzipSync(tar))
    fs.writeFileSync(zst, zlib.zstdCompressSync(tar))
    for (const [arc, out] of [[gz, 'o1'], [zst, 'o2']]) {
      await extractArchive(arc, path.join(dir, out))
      assert.ok(fs.readFileSync(path.join(dir, out, 'journal-pretty.log')).equals(content))
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('拒绝符号链接与硬链接条目', async () => {
  const dir = tmpdir('onetree-t3-')
  try {
    const evil = buildTar([{ name: 'etc/passwd', content: 'x', type: '2' }])
    const p = path.join(dir, 'evil.tar')
    fs.writeFileSync(p, evil)
    await assert.rejects(() => extractArchive(p, path.join(dir, 'out')), /链接条目/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('拒绝路径逃逸（../）条目', async () => {
  const dir = tmpdir('onetree-t4-')
  try {
    const evil = buildTar([{ name: '../../onetree-escape-marker.txt', content: 'x' }])
    const p = path.join(dir, 'evil.tar')
    fs.writeFileSync(p, evil)
    await assert.rejects(() => extractArchive(p, path.join(dir, 'out')), /不安全/)
    const marker = path.join(dir, '..', '..', 'onetree-escape-marker.txt')
    assert.equal(fs.existsSync(marker), false, '逃逸文件绝不能被写出')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('拒绝截断归档与空文件', async () => {
  const dir = tmpdir('onetree-t5-')
  try {
    const tar = buildTar([{ name: 'a.log', content: 'data' }])
    // 截在载荷中间（header 512B + 载荷 2/4B）
    const p = path.join(dir, 'trunc.tar')
    fs.writeFileSync(p, tar.subarray(0, 512 + 2))
    await assert.rejects(() => extractArchive(p, path.join(dir, 'out')), /中途结束/)
    fs.writeFileSync(path.join(dir, 'empty.tar'), Buffer.alloc(0))
    await assert.rejects(() => extractArchive(path.join(dir, 'empty.tar'), path.join(dir, 'o2')), /不是有效的 tar/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('不支持的扩展名报清晰错误', async () => {
  const dir = tmpdir('onetree-t6-')
  try {
    const p = path.join(dir, 'x.rar')
    fs.writeFileSync(p, Buffer.alloc(10))
    await assert.rejects(() => extractArchive(p, path.join(dir, 'out')), /不支持的压缩格式/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
