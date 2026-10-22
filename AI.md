# AI.md — 维护与安装入口

## 当前形态

- `package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，这是当前唯一权威组合。
- `agent.cordis.yml`、`preset.yml` 是旧格式备查，不参与加载，不要修改它们来配置现版。
- 自定义模块仅依赖 Node 内置模块及本包相对导入；组合仍依赖 DSH 官方插件与服务。
- v3.0 起工具面由 `tool-gate.mjs` 治理：首轮只常驻 `DEFAULT_RESIDENT_TOOLS`，其余用 `dev_tool_search` 解锁；`mode: full` 一键回退全量。旧的 `dev-tool-search.mjs` / `tool-bootstrap.mjs` / `context-gate.mjs` 是 v1 anchored 实现，**保持不挂载**，不要与原语不同的新门控同时启用。
- v3.1 起路由取最近真实用户请求（含 consult 带）；`delivery_check` 的实现抽到 `delivery-check.mjs`；`dev_tool_search` 增加固定 `groups`；shell 路由文案以 `shell-policy.mjs` 为唯一来源。
- v3.1.0 修复复审：明确问句优先于动词、范围限制仍实施、多段 runtime 快照整块剥离；gate 恢复必须 callId 配对成功 result；视觉交付必须接受 reviewed 图片证据；真实 DSH Tools 注册与 `tool/result.meta` 恢复有集成测试。

## v3.1 关键模块

| 文件 | 作用 |
|---|---|
| `router-core.mjs` | 来源白名单、逆序最近用户请求、多段 runtime 快照剥离、问句优先/范围限制、简短应承沿用、consult 分类、overlay 边界句 |
| `router-progressive.mjs` | overlay 注入、`dev_router_status`、`delivery_check` 注册与递归 JSON Schema（父 required 只认 `required:true`） |
| `delivery-check.mjs` | 纯函数交付检查：原生绝对 cwd、可读普通非空文件、UTF-8/图片/PDF/ZIP 边界、视觉证据、SHA256 |
| `tool-gate.mjs` | 常驻裁剪、`query`/`toolNames`/`groups` 解锁、`tool/result.meta.accepted` callId 配对持久化与保守恢复 |
| `shell-policy.mjs` | 唯一 shell 路由字符串、order 10300 系统 section、环境简报与工具描述复用 |
| `environment-context.mjs` | 每轮系统环境段与请求 model/provider 模板；等待首次异步探测 |
| `env-probe.mjs` | 环境采集、缓存刷新、Git Bash/pwsh 工具 |
| `powershell-runtime.mjs` | 验证 PowerShell 版本、固定实际可执行文件 |
| `shell-workdir.mjs` | 工作目录校验、世界分派、POSIX 参数转义、失败阻断 |
| `instruction-hint.mjs` | 指令文件发现；专用 producer kind 与旧日志兼容 |
| `wsl-bash.mjs` | Windows 下独立 WSL Bash 进程 |
| `skill-search.mjs` | 技能按需搜索和加载 |

## 不得破坏的约束

1. `persona.complete: false`：DSH 的 `complete:true` 会只保留 persona prefix，丢弃环境段和 waterfall 中追加的路由提示。`includeRuntimeContext:false` 只压制其他动态 runtime context，不影响本包系统 section。
2. 使用 `{{model}}` / `{{provider}}` 获取官方模型选择器的当前请求路由。不要改成 `agent.options.model`、上次请求 header 或首轮模型缓存。ID 无法揭示反向代理内部的模型映射。
3. DSH 在 `agent/pre-step` 前已 assemble；首次环境探测必须在 `system-prompt/assemble` 内等待。不要递归 assemble。环境事实通过变量单次插值，目录中的 `{{...}}` 必须保持原文。
4. 环境不再注入持久 user 消息，不会在重启、恢复或压缩时生成重复 `env-brief-*` ID。`env_probe` 主动刷新缓存供后续请求使用。
5. Shell 路由以 `shell-policy.mjs` 为唯一文案来源：Windows 通用执行优先 Git Bash；**Git Bash 不可用时由已验证绑定的 pwsh 处理 Windows 通用任务**，pwsh 同时用于 PowerShell 专属命令、`.ps1`、Windows UI；**bash 只用于 Linux-only 工作，绝不是 Windows 回退**；原生 Linux/macOS/Android 用 native shell；ops_bash 只在适用环境能力明确时使用。persona 只引用该 section，不再复制路由表。需要 PowerShell 时调用绑定的 `pwsh` 工具：优先 PowerShell 7，没有 7 才使用系统默认后端并显示实际版本。执行失败不能触发另一次隐式降级，也不能越过权限拒绝。section order 10300 由真实 `SystemPrompt` 测试验证位于内置 persona suffix 之后，不能只靠 mock order 断言。
6. 工作目录必须为相应后端支持的绝对路径；显式空值、相对路径、NUL、未知世界直接报错。Git Bash 的 `cd -- <quoted>` 失败后绝不执行后续命令。不要恢复 SystemRoot 静默回退。
7. 平台 shell/editor 分派互斥；保留 `wsl-` 变体自禁用条件；服务行按需隔离 realm。
8. persona 前缀必须保留 `Reasoning language: think in Chinese (简体中文)` 这一条（v2.3.0 起）：中文思考由系统提示词强制，不依赖记忆或用户当场提醒。改写人设时不得删除，也不得因此把 `complete` 改成 `true`。
9. 工具门控纪律（v3.0.0 起，v3.1.0 更新）：
   - 裁剪只作用于 `system-prompt/assemble` 的 `tools`，不动 sections；`ctx.tools.schemas(exec.agent)` 必须保持全量，否则 `dev_tool_search` 搜不到被锁工具。
   - 门控工具 `dev_tool_search` 必须常驻且能注册成功；缺失时过滤器降级全量并只告警一次，宁可多花 token 也不锁死会话。
   - v3.1 起成功解锁的实际 accepted 精确名写入官方 `tool/result.meta`（`output.presentationMeta`），不要凭空 append 未注册事件；冷启动/压缩后只从**与本会话一条 `dev_tool_search` callId 配对成功**的 result 恢复。其它工具的文本/meta、伪造 `gate` 名、没有 result 的 tool/call（无法区分中断）都不得解锁；旧日志需要重新调用 `dev_tool_search`。v3.0 固定成功文案同样必须配对 call。没有 `agent.session` 时 `execute` 返回 `accepted: []` 并明确说明未解锁。
   - `groups` 只从执行 scope 的实际目录展开并去重，不绕 scope 解锁不可见工具，不授予权限；恢复时只加已持久化的精确名，绝不在恢复时重新展开组定义。
   - 子代理默认不裁剪（`includeSubagents: false`）；改成 `true` 前先确认子代理任务不依赖非常驻工具。
   - 调整 `residentTools` 时保持精简（当前 29 个）；每加一个常驻工具，所有会话每轮都要多付它的 schema。
10. v3.1 路由纪律：`sessionMode` 逆序取最近真实用户实质请求；来源白名单为用户/旧无 source，自动通知、插件、model-selection、user-approval、memory/runtime 包装块不计。`Current runtime context` 必须按整个多段快照剥离到消息末尾，不能只删标题段。明确问句（如何/为什么/how/what…）优先于实施动词；「只做这个错误的修复」「修复这个错误，不要改其他文件」是范围限制，仍走 spec。「继续/好的/可以」沿用上一实质任务；无可靠意图 weak。consult 只用于解释/评审/只读/先给计划，明确实施动词仍走 react/spec。英文动词按单词边界，避免 add/write/how 子串误判。overlay 必须声明不授予权限，用户请求、计划模式、审批规则优先。
11. `delivery_check` 只做基础文件与证据检查：相对路径必须来自 `exec.agent.session.header.cwd`；无 cwd、相对 cwd、drive-relative/root-relative、外部平台绝对路径都 FAIL；不得退回 `process.cwd()`。未知扩展也要验证可读；格式读取异常转 FAIL 不抛出。图片/PDF/docx/pptx 页面交付至少一项 accepted `page`/`image` 且 `reviewed:true`，视觉 target 必须是可通过签名检查的图片；xlsx 用数据/测试证据。PASS 不得宣称语义/视觉/完整格式有效。

## 安装

```bash
dsh plugin --profile web add "file:/absolute/path/to/this/repo"
```

使用对应宿主的官方插件管理 CLI 管理实际 profile。不要直接复制 `node_modules`，不要把子目录当作 profile 根目录。桌面 `desktop` 是保留 profile，使用桌面应用自带 CLI 管理，不要用普通 CLI boot 它。

安装是快照，`git pull` 后需重新安装并重启宿主。不要承诺源码修改会自动更新已安装副本。

## 校验

```bash
npm test
# 真实 prompt registry / model-selection / tools registry / tool-result.meta 集成测试
DSH_TEST_ANCHOR=/path/to/dsh npm test
# 同时跑本机真实 PowerShell 7 测试
DSH_TEST_ANCHOR='C:/Users/admin/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh' \
PWSH_RUNTIME_REAL_PATH='C:/Program Files/PowerShell/7/pwsh.exe' npm test
```

- `node --check` 检查所有运行 `.mjs`。
- 当前 Windows 工作树在同时设置两个环境变量后：**122 tests / 122 pass / 0 fail / 0 skip**。没有 anchor 或真实 pwsh 路径时，对应集成用例会显式 skip，不能写成已通过。
- v3.1 新增/扩展测试：`tests/router-core.test.mjs`、`tests/delivery-check.test.mjs`、`tests/shell-policy.test.mjs`、`tests/dsh-tool-runtime.test.mjs`，并扩展 `tests/tool-gate.test.mjs` 的组/作用域/配对恢复/伪造 result/无 result 中断覆盖，以及 `tests/dsh-integration.test.mjs` 使用真实 `dsh-tools` registry。
- 离线组合 schema 校验使用本机工作区配套 `verify-dsh-preset-bundle.mjs`；它是补充，不替代真实 prompt 渲染测试。
- Windows 实机验证绑定路径、`$PSVersionTable.PSVersion`、中文输出和工具执行 cwd；不要为验证而重启用户当前会话。
- 发布前审阅 `git diff --check`、测试和 npm 包内容；上传版本号对应的包与校验和。
