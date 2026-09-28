/**
 * http.test.js — 路由层行为（经 lib/index.js apply() 起真实 HTTP 服务）：
 *   - file 预览带 previewBytes（UTF-8 字节数，中文不偏小）
 *   - resolveFile 的 '..' 按路径段判断：'a..b.log' 放行，'../x' 拒绝
 *   - DELETE：存在 → 200 {ok:true}；不存在 → 404 {ok:false, error:'dump 不存在'}
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { apply } from '../lib/index.js'
import { tmpdir } from './fixtures.js'

function startApp() {
  const routes = []
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    webRuntime: { trustedHosts: [] },
    webServer: { register: r => routes.push(r) },
    effect: fn => fn(),
  }
  apply(ctx)
  const app = http.createServer((req, res) => routes[0].handler(req, res))
  return new Promise(resolve => {
    app.listen(0, '127.0.0.1', () => resolve({ app, port: app.address().port }))
  })
}

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const raw = Buffer.concat(chunks)
        let json = null
        try { json = JSON.parse(raw.toString('utf8')) } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body: json })
      })
    })
    req.on('error', reject)
    body !== undefined ? req.end(body) : req.end()
  })
}

test('HTTP：previewBytes、a..b.log 放行、DELETE 200/404 body 区分', async () => {
  const home = tmpdir('onetree-http-')
  process.env.ONETREE_LOG_DIR = path.join(home, 'store')
  const { app, port } = await startApp()
  try {
    // 准备并登记一个已解压 dump 目录（selinfo.log + journal-pretty.log → 强标记命中）
    const dumpDir = path.join(home, 'mydump')
    fs.mkdirSync(dumpDir, { recursive: true })
    fs.writeFileSync(path.join(dumpDir, 'selinfo.log'), 'SEL | 1 | event')
    const cn = '中文日志内容' // 6 个字符 / 18 个 UTF-8 字节
    fs.writeFileSync(path.join(dumpDir, 'journal-pretty.log'), cn)

    const reg = await request(port, 'POST', '/onetree-log/open-path', JSON.stringify({ path: dumpDir }))
    assert.equal(reg.status, 200)
    const id = reg.body.dump.id

    // 预览：previewBytes 是 UTF-8 字节数，与 UTF-16 字符数（content.length）不同
    const preview = await request(port, 'GET', `/onetree-log/dumps/${id}/file?path=${encodeURIComponent('journal-pretty.log')}`)
    assert.equal(preview.status, 200)
    assert.equal(preview.body.binary, false)
    assert.equal(preview.body.content, cn)
    assert.equal(preview.body.previewBytes, Buffer.byteLength(cn, 'utf8'))
    assert.notEqual(preview.body.previewBytes, cn.length)

    // 'a..b.log' 是合法文件名，不因包含 '..' 子串被误拒
    fs.writeFileSync(path.join(dumpDir, 'a..b.log'), 'fine')
    const dots = await request(port, 'GET', `/onetree-log/dumps/${id}/file?path=${encodeURIComponent('a..b.log')}`)
    assert.equal(dots.status, 200)
    assert.equal(dots.body.content, 'fine')

    // 真正的路径逃逸仍拒绝
    const esc = await request(port, 'GET', `/onetree-log/dumps/${id}/file?path=${encodeURIComponent('../x')}`)
    assert.equal(esc.status, 400)

    // DELETE：存在 → 200 {ok:true}；不存在 → 404 {ok:false, error}
    const del1 = await request(port, 'DELETE', `/onetree-log/dumps/${id}`)
    assert.equal(del1.status, 200)
    assert.deepEqual(del1.body, { ok: true })
    const del2 = await request(port, 'DELETE', `/onetree-log/dumps/${id}`)
    assert.equal(del2.status, 404)
    assert.deepEqual(del2.body, { ok: false, error: 'dump 不存在' })

    // path-dir 登记：删除只清登记目录，用户原目录必须还在
    assert.ok(fs.existsSync(path.join(dumpDir, 'selinfo.log')))
  } finally {
    app.close()
    app.closeAllConnections?.()
    delete process.env.ONETREE_LOG_DIR
    fs.rmSync(home, { recursive: true, force: true })
  }
})
