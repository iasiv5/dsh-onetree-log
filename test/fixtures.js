/** 测试夹具：无依赖 tar 构造器与临时目录。 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export function tarHeader(name, size, type = '0') {
  const b = Buffer.alloc(512)
  b.write(name, 0, 100)
  b.write('0000644\0', 100, 8)
  b.write('0000000\0', 108, 8)
  b.write('0000000\0', 116, 8)
  b.write(size.toString(8).padStart(11, '0') + '\0', 124, 12)
  b.write('00000000000\0', 136, 12)
  b.write('        ', 148, 8)
  b.write(type, 156, 1)
  b.write('ustar\0', 257, 6)
  b.write('00', 263, 2)
  return b
}

const padTo = n => Buffer.alloc((512 - (n % 512)) % 512)

/**
 * entries: [{name, content(string|Buffer), type?}]；name 以 / 结尾或 type '5' 为目录。
 * 返回带 1024 结尾空块的完整 tar Buffer。
 */
export function buildTar(entries) {
  const parts = []
  for (const e of entries) {
    if (e.type === '5' || e.name.endsWith('/')) {
      parts.push(tarHeader(e.name, 0, '5'))
    } else {
      const content = Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content)
      parts.push(tarHeader(e.name, content.length, e.type ?? '0'))
      parts.push(content)
      parts.push(padTo(content.length))
    }
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}

export function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}
