# dsh-onetree-log

AMI MegaRAC OneTree 一键日志（OpenBMC dreport dump）上传与分析框架 —— DSH 插件。

在 DSH「设置 → OneTree 日志」面板里上传 OneTree 一键日志压缩包（或登记服务器本地
路径），插件自动**安全解包 → 探测 dump 根 → 文件清单与分类导航 → 文件预览**。
本仓库是第一阶段（框架）；第二阶段在同一内核上挂逐域解析器
（SEL / 传感器 / journal / 服务 / POST code …），见下文「第二阶段扩展点」。

> 设计蓝本：[openUBMC bmcstudio_log_reviewer](https://gitcode.com/openUBMC/bmcstudio_log_reviewer)
> 的"内核 + 薄入口"架构（解析内核独立于 UI，路由化契约，机型知识外置）。
> OneTree 背景：MegaRAC OneTree 是 AMI 的 OpenBMC 商业发行版，一键日志由
> phosphor-debug-collector（dreport）产出（`selinfo.log`、`journal-pretty.log`、
> `dmesg.log`、`fru-info.log` …一组命令输出文件，tar 打包，常为 zstd 压缩）。

## 功能（第一阶段）

- **上传**：浏览器直传压缩包（原始字节流 POST，流式落盘，≤512MB；>20MB 受入口
  网关限制时建议改走服务器路径）
- **登记服务器路径**：压缩包或已解压 dump 目录原地登记（无大小限制，适合超大日志）
- **自动解包探测**：`.tar / .tar.gz / .tgz / .tar.zst / .tzst / .zip`；嵌套包装
  （zip 套 tar 等）自动展开 ≤2 层；标记评分定位 dump 根；SP-X FFDC 血统给出专门提示
- **文件清单**：按 14 个域分类（SEL/传感器/系统日志/FRU/服务/启动/网络…），
  统计 chips 过滤 + 目录树 + 单文件文本预览（256KB，二进制探测）
- **生命周期**：dump 登记持久化（重启不丢）；删除时只清插件自建目录，
  path 登记的用户原文件/目录绝不动

## 安全

- 解包三防：zip-slip（绝对路径/`..`/NUL）、符号链接与硬链接条目直接拒绝、
  单文件 1GiB / 总量 2GiB / 条目 20k 上限
- 文件预览路径二次校验（resolveFile 拒绝逃逸）
- 信任围栏与 dsh-obmc-web 同款：Host 须 loopback 或部署信任域、
  Sec-Fetch-Site 不得 cross-site、Origin 须同 Host 主机名
- 上传/请求体限额：上传 512MB、JSON 8KB、预览 256KB

## 架构

```
lib/
├── index.js     宿主半身：/onetree-log* 路由（信任围栏 + JSON 契约）
├── client.js    客户端半身：settings.section「OneTree 日志」面板（React）
├── extract.js   解包内核：纯 JS 流式 tar（ustar/pax/GNU longname）+ zlib gz/zstd + zip 兜底
├── detect.js    dump 探测：标记评分（强/中/SP-X）、嵌套包装展开
├── inventory.js 文件清单：KNOWN_FILES 分类表 + 统计 + 目录树
└── store.js     登记持久化：~/.local/share/dsh-onetree-log/dumps/<id>/
test/            node:test 单测（解包安全用例 / 探测 / 清单 / store 全链路）
scripts/e2e.mjs  宿主半身端到端自测（mock ctx + 临时 HTTP 服务）
```

### HTTP 契约（宿主半身）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/onetree-log/upload?name=<原文件名>` | 原始字节流上传 → 解包探测登记 |
| POST | `/onetree-log/open-path` `{path,label?}` | 登记服务器本地压缩包/目录 |
| GET | `/onetree-log/dumps` | 登记列表（时间倒序） |
| GET | `/onetree-log/dumps/<id>` | 详情（meta + inventory） |
| GET | `/onetree-log/dumps/<id>/file?path=<rel>` | 文件预览 |
| DELETE | `/onetree-log/dumps/<id>` | 删除登记 |

## 安装

```bash
# 市场（发布后）
dsh plugin --profile web add @iasiv5/dsh-onetree-log
# 源码本地（开发模式）
dsh plugin --profile web add link:/path/to/dsh-onetree-log
```

安装后重启 dsh web 生效。数据目录可用 `ONETREE_LOG_DIR` 环境变量覆盖。

## 开发

```bash
node --test 'test/*.test.js'   # 17 个单测
node scripts/e2e.mjs           # 宿主半身端到端
```

无构建步骤：`lib/` 即发布产物（与 dsh-surf / dsh-obmc-web 一致的薄插件风格）。
宿主半身需要 Node ≥22.15（zlib 原生 zstd；旧版本自动回退系统 `zstd -dc`）。

## 第二阶段扩展点（逐域解析）

内核已按 section 预留挂钩，第二阶段只需：

1. `lib/sections/<name>.js`：实现 `parse(files, ctx) → 结构化结果`
   （如 `sel.js` 解析 `ipmitool sel list` 行为事件表、`sensors.js` 解析传感器阈值矩阵）
2. `lib/index.js`：新增路由 `GET /onetree-log/dumps/<id>/section/<name>`
   （按 `inventory` 的 section 找到文件集 → 调解析器 → JSON 返回）
3. `lib/client.js`：详情页为每个 section 加一个渲染卡片（表格/图表）
4. 规则诊断（对齐 bmcstudio_log_reviewer 的 detection-report 形态）：
   `diagnose.js` 消费各 section 结果产出 `{Severity, Items:[{severity,msg,fix,evidence}]}`
5. 真实样本回归：拿到脱敏真机 dump 后建 `test/golden/` 冻结快照

分类表在 `lib/inventory.js` 的 `KNOWN_FILES`（文件名 → section），新文件名只需加一行。

## License

MIT
