/**
 * scripts/e2e.mjs — 宿主半身端到端自测（不起 DSH，用 mock ctx + 临时 HTTP 服务）。
 *
 * 用法：node scripts/e2e.mjs
 * 覆盖：upload（原始流）→ dumps 列表 → detail（清单/分类）→ file 预览 →
 * open-path（目录登记）→ DELETE → 404 → 信任围栏（伪造 Origin 拒绝）。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { apply } from '../lib/index.js'
import { buildTar } from '../test/fixtures.js'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'onetree-e2e-'))
process.env.ONETREE_LOG_DIR = home

// mock ctx：把 register 的 handler 挂到本地 http server
const routes = []
const ctx = {
  logger: { info: () => {}, warn: () => {} },
  webRuntime: { trustedHosts: [] },
  webServer: { register: route => routes.push(route) },
  effect: fn => fn(),
}
apply(ctx)

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const route = routes.find(r => url.pathname.startsWith(r.path))
  if (!route) { res.writeHead(404); res.end('no route'); return }
  route.handler(req, res)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

let failed = 0
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ✓ ${name}` : `  ✗ ${name} ${extra}`)
  if (!cond) failed += 1
}

// 1. 构造 OneTree dump 压缩包并上传
const tar = buildTar([
  { name: 'selinfo.log', content: 'SEL Record 1 | Platform Event\n' },
  { name: 'sensorinfo.log', content: 'CPU0 Temp | 45 | ok\n' },
  { name: 'journal-pretty.log', content: 'systemd[1]: Started xyz.service\n' },
  { name: 'dmesg.log', content: '[0.000] Linux version...\n' },
])
const archive = path.join(home, 'ffdc-sample.tar')
fs.writeFileSync(archive, tar)

const uploadRes = await fetch(`${base}/onetree-log/upload?name=${encodeURIComponent('ffdc-sample.tar')}`, {
  method: 'POST',
  body: fs.readFileSync(archive),
})
const uploadData = await uploadRes.json()
check('upload 返回 ok + dump 元数据', uploadRes.status === 200 && uploadData.ok === true && uploadData.dump.detected.score >= 9, JSON.stringify(uploadData).slice(0, 120))
const id = uploadData.dump?.id

// 2. 列表
const listData = await (await fetch(`${base}/onetree-log/dumps`)).json()
check('dumps 列表含刚上传的 dump', listData.dumps?.some(d => d.id === id))

// 3. 详情（清单 + 分类统计）
const detail = await (await fetch(`${base}/onetree-log/dumps/${id}`)).json()
check('detail 清单 4 个文件', detail.inventory?.stats?.totalFiles === 4, JSON.stringify(detail.inventory?.stats))
check('sel/journal 分类正确', detail.inventory?.stats?.sections?.sel?.count === 1 && detail.inventory?.stats?.sections?.journal?.count === 2)

// 4. 文件预览
const preview = await (await fetch(`${base}/onetree-log/dumps/${id}/file?path=selinfo.log`)).json()
check('预览返回文本内容', preview.binary === false && preview.content?.includes('Platform Event'))
const badPreview = await fetch(`${base}/onetree-log/dumps/${id}/file?path=../meta.json`)
check('预览路径逃逸被拒', badPreview.status === 400)

// 5. open-path 登记目录
const dirDump = path.join(home, 'unpacked')
fs.mkdirSync(dirDump)
fs.writeFileSync(path.join(dirDump, 'selinfo.log'), 'x')
fs.writeFileSync(path.join(dirDump, 'journal-pretty.log'), 'y')
const openRes = await fetch(`${base}/onetree-log/open-path`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ path: dirDump }),
})
const openData = await openRes.json()
check('open-path 目录登记成功', openRes.status === 200 && openData.ok === true)
const dirId = openData.dump?.id
fs.rmSync(dirDump, { recursive: true, force: true })
const afterRm = await fetch(`${base}/onetree-log/dumps/${dirId}/file?path=selinfo.log`)
check('登记目录被用户删除后预览报错（不崩）', afterRm.status === 400)

// 6. 删除
const delRes = await fetch(`${base}/onetree-log/dumps/${dirId}`, { method: 'DELETE' })
check('DELETE 移除登记', delRes.status === 200)
const gone = await fetch(`${base}/onetree-log/dumps/${dirId}`)
check('删除后 404', gone.status === 404)

// 7. 非 OneTree 包被拒
const wrong = path.join(home, 'wrong.tar')
fs.writeFileSync(wrong, buildTar([{ name: 'notes.txt', content: 'nothing here' }]))
const wrongRes = await fetch(`${base}/onetree-log/open-path`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ path: wrong }),
})
const wrongData = await wrongRes.json()
check('非 OneTree 包返回可读错误', wrongRes.status === 400 && /未找到 OneTree/.test(wrongData.error), wrongData.error?.slice(0, 60))

// 8. 信任围栏：伪造跨站 Origin
const evilRes = await fetch(`${base}/onetree-log/dumps`, { headers: { origin: 'https://evil.example' } })
check('伪造 Origin 被 403', evilRes.status === 403)

// 9. 清理上传的 dump
await fetch(`${base}/onetree-log/dumps/${id}`, { method: 'DELETE' })

server.close()
fs.rmSync(home, { recursive: true, force: true })
console.log(failed === 0 ? '\nE2E ALL OK' : `\nE2E FAILED: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
