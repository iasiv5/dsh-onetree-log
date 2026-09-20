// dsh-onetree-log client half.
//
// 设置一级菜单「OneTree 日志」面板：上传 OneTree 一键日志压缩包 / 登记服务器
// 本地路径 → 解包探测 → dump 列表 → 详情（分类统计 + 文件树 + 文件预览）。
// 与宿主半身经同源 /onetree-log* 路由通信（fetch 不受 X-Frame-Options 影响）。
//
// The package registration id MUST equal package.json `name`.
window.__ModuleLoader__.load({
  id: '@iasiv5/dsh-onetree-log',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const h = React.createElement

    const SECTION_ID = 'dsh-onetree-log'
    const NAV_LABEL = 'OneTree 日志'
    const BASE = '/onetree-log'

    const SECTION_META = {
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

    // ── 工具 ────────────────────────────────────────────────────────────

    function humanBytes(n) {
      if (n === null || n === undefined) return ''
      if (n < 1024) return `${n} B`
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
      if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
      return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
    }

    function formatTime(iso) {
      if (!iso) return ''
      try { return new Date(iso).toLocaleString() } catch { return iso }
    }

    async function api(path, options) {
      const response = await fetch(`${BASE}${path}`, { cache: 'no-store', ...options })
      let data = null
      try { data = await response.json() } catch { /* non-JSON */ }
      if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`)
      return data
    }

    // ── 上传卡片 ────────────────────────────────────────────────────────

    function UploadCard({ onDone }) {
      const [progress, setProgress] = React.useState(null) // {loaded,total}
      const [error, setError] = React.useState(null)
      const inputRef = React.useRef(null)

      const upload = file => {
        if (!file) return
        setError(null)
        setProgress({ loaded: 0, total: file.size })
        const xhr = new XMLHttpRequest()
        xhr.open('POST', `${BASE}/upload?name=${encodeURIComponent(file.name)}`)
        xhr.upload.onprogress = e => { if (e.lengthComputable) setProgress({ loaded: e.loaded, total: e.total }) }
        xhr.onerror = () => { setProgress(null); setError('上传失败（网络错误；超过 20MB 的日志可能被入口限制，建议放到服务器本地后用「登记服务器路径」）') }
        xhr.onload = () => {
          setProgress(null)
          try {
            const data = JSON.parse(xhr.responseText)
            if (xhr.status >= 200 && xhr.status < 300 && data.ok) onDone(data.dump)
            else setError(data.error || `上传失败（HTTP ${xhr.status}）`)
          } catch { setError(`上传失败（HTTP ${xhr.status}）`) }
        }
        xhr.send(file)
      }

      const pct = progress && progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : 0
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('input', {
          ref: inputRef,
          type: 'file',
          accept: '.tar,.tar.gz,.tgz,.tar.zst,.tzst,.zip',
          style: { display: 'none' },
          onChange: e => { upload(e.target.files?.[0]); e.target.value = '' },
        }),
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          h('button', {
            type: 'button',
            disabled: progress !== null,
            onClick: () => inputRef.current?.click(),
          }, progress !== null ? '上传中…' : '📤 上传一键日志压缩包'),
          h('span', { style: { fontSize: '12px', opacity: 0.7 } },
            '.tar / .tar.gz / .tgz / .tar.zst / .zip，≤512MB'),
        ),
        progress !== null && h('div', { style: { fontSize: '12px' } },
          `${pct}% · ${humanBytes(progress.loaded)} / ${humanBytes(progress.total)}（上传后自动解包探测）`),
        error && h('div', { style: { color: '#f87171', fontSize: '12px', whiteSpace: 'pre-wrap' } }, error),
      )
    }

    // ── 服务器路径卡片 ──────────────────────────────────────────────────

    function PathCard({ onDone }) {
      const [value, setValue] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)

      const submit = async () => {
        const p = value.trim()
        if (p === '' || busy) return
        setBusy(true); setError(null)
        try {
          const data = await api('/open-path', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: p }),
          })
          setValue('')
          onDone(data.dump)
        } catch (e) { setError(e.message) } finally { setBusy(false) }
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('div', { style: { display: 'flex', gap: '8px' } },
          h('input', {
            type: 'text',
            value,
            placeholder: '服务器本地路径：压缩包或已解压的 dump 目录',
            onChange: e => setValue(e.target.value),
            onKeyDown: e => { if (e.key === 'Enter') submit() },
            style: { flex: 1, minWidth: 0 },
          }),
          h('button', { type: 'button', disabled: busy || value.trim() === '', onClick: submit },
            busy ? '导入中…' : '🗂 登记服务器路径'),
        ),
        h('div', { style: { fontSize: '12px', opacity: 0.7 } },
          '超大日志推荐：先 scp 到服务器，再登记路径（不受上传大小限制）'),
        error && h('div', { style: { color: '#f87171', fontSize: '12px', whiteSpace: 'pre-wrap' } }, error),
      )
    }

    // ── dump 列表 ───────────────────────────────────────────────────────

    function DumpItem({ dump, onOpen, onDelete }) {
      const sourceLabel = { upload: '上传', 'path-archive': '本地包', 'path-dir': '本地目录' }[dump.sourceKind] ?? dump.sourceKind
      return h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px',
          border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
          borderRadius: '10px',
        },
      },
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            dump.label),
          h('div', { style: { fontSize: '12px', opacity: 0.7, marginTop: '2px' } },
            `${formatTime(dump.createdAt)} · ${sourceLabel}`
            + (dump.archiveSize ? ` · ${humanBytes(dump.archiveSize)}` : '')
            + ` · 识别分 ${dump.detected.score}`),
        ),
        h('button', { type: 'button', onClick: () => onOpen(dump.id) }, '查看'),
        h('button', { type: 'button', onClick: () => onDelete(dump.id) }, '删除'),
      )
    }

    // ── 文件树 ──────────────────────────────────────────────────────────

    function TreeNode({ node, depth, onPick, pickedPath }) {
      const [open, setOpen] = React.useState(depth < 1)
      const meta = node.section ? SECTION_META[node.section] : null
      const row = (children) => h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: '6px', padding: '2px 6px',
          cursor: 'pointer', borderRadius: '4px', paddingLeft: `${6 + depth * 14}px`,
          background: pickedPath === node.path ? 'rgba(96,165,250,0.15)' : undefined,
          fontSize: '13px',
        },
        onClick: e => { e.stopPropagation(); if (node.dir) setOpen(!open); else onPick(node) },
      },
        node.dir ? h('span', { style: { opacity: 0.7, width: '12px' } }, open ? '▾' : '▸') : h('span', { style: { width: '12px' } }),
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, node.name || '/'),
        !node.dir && meta && h('span', {
          style: { fontSize: '10px', color: meta.color, border: `1px solid ${meta.color}55`, borderRadius: '999px', padding: '0 6px', flexShrink: 0 },
        }, meta.label),
        h('span', { style: { marginLeft: 'auto', opacity: 0.6, fontSize: '11px', flexShrink: 0 } },
          node.dir ? `${node.fileCount} 项 · ${humanBytes(node.size)}` : humanBytes(node.size)),
        children,
      )
      if (node.dir && open && node.children) {
        return h('div', null,
          row(),
          ...node.children.map(child =>
            h(TreeNode, { key: child.name, node: { ...child, path: (node.path ? node.path + '/' : '') + child.name }, depth: depth + 1, onPick, pickedPath })))
      }
      return row()
    }

    // ── 文件预览 ────────────────────────────────────────────────────────

    function Preview({ dumpId, file }) {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        setData(null); setError(null)
        api(`/dumps/${encodeURIComponent(dumpId)}/file?path=${encodeURIComponent(file.path)}`)
          .then(d => { if (alive) setData(d) })
          .catch(e => { if (alive) setError(e.message) })
        return () => { alive = false }
      }, [dumpId, file.path])
      return h('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))', paddingTop: '10px' } },
        h('div', { style: { fontSize: '12px', marginBottom: '6px' } },
          h('strong', null, file.path), ` · ${humanBytes(file.size)}`),
        error && h('div', { style: { color: '#f87171', fontSize: '12px' } }, error),
        data && data.binary && h('div', { style: { fontSize: '12px', opacity: 0.8 } }, '二进制文件，不预览'),
        data && !data.binary && h('pre', {
          style: {
            margin: 0, padding: '10px', maxHeight: '320px', overflow: 'auto',
            background: 'rgba(127,127,127,0.08)', borderRadius: '8px', fontSize: '12px',
            whiteSpace: 'pre-wrap', wordBreak: 'break-all',
          },
        }, data.content),
        data && data.truncated && h('div', { style: { fontSize: '11px', opacity: 0.6, marginTop: '4px' } },
          `（仅显示前 ${humanBytes(data.content ? data.content.length : 0)}，完整内容请到服务器查看解压目录）`),
      )
    }

    // ── dump 详情 ───────────────────────────────────────────────────────

    function DumpDetail({ dumpId, onBack }) {
      const [detail, setDetail] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [section, setSection] = React.useState(null) // 分类过滤
      const [picked, setPicked] = React.useState(null)

      React.useEffect(() => {
        let alive = true
        api(`/dumps/${encodeURIComponent(dumpId)}`)
          .then(d => { if (alive) setDetail(d) })
          .catch(e => { if (alive) setError(e.message) })
        return () => { alive = false }
      }, [dumpId])

      if (error) return h('div', null,
        h('div', { style: { color: '#f87171', marginBottom: '8px' } }, error),
        h('button', { type: 'button', onClick: onBack }, '← 返回列表'))
      if (!detail) return h('div', { style: { opacity: 0.7 } }, '加载中…')

      const inv = detail.inventory
      const sections = Object.entries(inv?.stats?.sections ?? {})
        .sort((a, b) => b[1].bytes - a[1].bytes)

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
          h('button', { type: 'button', onClick: onBack }, '←'),
          h('strong', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, detail.label),
        ),
        h('div', { style: { fontSize: '12px', opacity: 0.75 } },
          `${formatTime(detail.createdAt)} · 识别分 ${detail.detected.score} · 命中标记 ${(detail.detected.markers.strong || []).length} 强 / ${(detail.detected.markers.medium || []).length} 中`
          + ` · ${inv?.stats?.totalFiles ?? 0} 个文件 · ${humanBytes(inv?.stats?.totalBytes ?? 0)}`),
        inv?.error && h('div', { style: { color: '#f87171', fontSize: '12px' } }, `清单构建失败: ${inv.error}`),

        // 分类统计 chips（可点选过滤）
        sections.length > 0 && h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
          h('button', {
            type: 'button',
            onClick: () => setSection(null),
            style: section === null ? { borderColor: '#60a5fa', color: '#60a5fa' } : undefined,
          }, '全部'),
          sections.map(([key, s]) => {
            const meta = SECTION_META[key] ?? { label: s.label ?? key, color: '#9ca3af' }
            const active = section === key
            return h('button', {
              key, type: 'button',
              onClick: () => setSection(active ? null : key),
              style: { borderColor: meta.color + '88', color: active ? meta.color : undefined },
            }, `${meta.label} ${s.count}`)
          }),
        ),

        // 文件树（或某分类的平铺文件表）
        inv && !section && inv.tree && h('div', {
          style: {
            border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
            borderRadius: '10px', padding: '8px', maxHeight: '420px', overflow: 'auto',
          },
        }, h(TreeNode, { node: inv.tree, depth: 0, onPick: setPicked, pickedPath: picked?.path })),
        inv && section && h('div', {
          style: {
            border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
            borderRadius: '10px', padding: '8px', maxHeight: '420px', overflow: 'auto',
          },
        }, inv.files.filter(f => !f.dir && f.section === section).map(f =>
          h('div', {
            key: f.path,
            onClick: () => setPicked(f),
            style: {
              display: 'flex', gap: '8px', padding: '3px 6px', cursor: 'pointer', fontSize: '13px',
              borderRadius: '4px', background: picked?.path === f.path ? 'rgba(96,165,250,0.15)' : undefined,
            },
          },
            h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 } }, f.path),
            h('span', { style: { opacity: 0.6, fontSize: '11px', flexShrink: 0 } }, humanBytes(f.size)),
          ))),

        inv?.truncated && h('div', { style: { fontSize: '11px', opacity: 0.6 } }, '（文件过多，清单已截断）'),
        picked && h(Preview, { dumpId, file: picked }),
      )
    }

    // ── 面板根组件 ──────────────────────────────────────────────────────

    function OneTreeLogSection() {
      const [dumps, setDumps] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [selected, setSelected] = React.useState(null)
      const [notice, setNotice] = React.useState(null)

      const refresh = React.useCallback(() => {
        api('/dumps')
          .then(data => { setDumps(data.dumps); setError(null) })
          .catch(e => setError(e.message))
      }, [])

      React.useEffect(() => { refresh() }, [refresh])

      const onIngested = dump => {
        setNotice(`已导入并识别：${dump.label}（识别分 ${dump.detected.score}）`)
        setSelected(dump.id)
        refresh()
      }

      const onDelete = async id => {
        try {
          await api(`/dumps/${encodeURIComponent(id)}`, { method: 'DELETE' })
          if (selected === id) setSelected(null)
          refresh()
        } catch (e) { setError(e.message) }
      }

      return h('section', {
        'data-onetree-log': 'settings-section',
        style: {
          display: 'flex', flexDirection: 'column', gap: '16px', padding: '16px',
          border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
          borderRadius: '12px',
        },
      },
        h('strong', null, NAV_LABEL),
        h('p', { style: { margin: 0, color: 'var(--dsw-alias-label-secondary, inherit)', fontSize: '13px' } },
          '上传 AMI MegaRAC OneTree 一键日志（OpenBMC dreport dump）压缩包，自动解包、探测与分类。' +
          '第一阶段：文件清单 + 分类导航 + 预览；第二阶段将接入 SEL/传感器/日志的逐域解析。'),
        h(UploadCard, { onDone: onIngested }),
        h(PathCard, { onDone: onIngested }),
        notice && h('div', { style: { color: '#34d399', fontSize: '12px' } }, notice),
        error && h('div', { style: { color: '#f87171', fontSize: '12px' } }, error),
        dumps !== null && dumps.length === 0 && !selected && h('div', { style: { fontSize: '13px', opacity: 0.7 } },
          '还没有登记过一键日志。'),
        dumps !== null && !selected && dumps.length > 0 && h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
          dumps.map(d => h(DumpItem, { key: d.id, dump: d, onOpen: setSelected, onDelete }))),
        selected !== null && h(DumpDetail, { dumpId: selected, onBack: () => { setSelected(null); refresh() } }),
      )
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        {
          name: 'settings.section',
          id: SECTION_ID,
          order: 140,
          label: NAV_LABEL,
        },
        OneTreeLogSection,
      ))
    }

    exports.name = 'dsh-onetree-log/client'
    exports.inject = ['slots']
    exports.apply = apply
    exports.OneTreeLogSection = OneTreeLogSection
    return module.exports
  },
})
