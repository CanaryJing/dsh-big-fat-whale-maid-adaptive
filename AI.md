# AI.md — 维护与安装入口

## 当前形态

- `package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，这是当前唯一权威组合。
- `agent.cordis.yml`、`preset.yml` 是旧格式备查，不参与加载，不要修改它们来配置现版。
- 自定义模块仅依赖 Node 内置模块及本包相对导入；组合仍依赖 DSH 官方插件与服务。
- v3.0 起工具面由 `tool-gate.mjs` 治理：首轮只常驻 `DEFAULT_RESIDENT_TOOLS`，其余用 `dev_tool_search` 解锁；`mode: full` 一键回退全量。旧的 `dev-tool-search.mjs` / `tool-bootstrap.mjs` / `context-gate.mjs` 是 v1 anchored 实现，**保持不挂载**，不要与原语不同的新门控同时启用。

## v3.0 关键模块

| 文件 | 作用 |
|---|---|
| `tool-gate.mjs` | 常驻核心裁剪、`dev_tool_search` 解锁、会话事件持久化、`mode: full` 回退、`describeGate()` 状态自检 |
| `environment-context.mjs` | 每轮系统环境段与请求 model/provider 模板；等待首次异步探测 |
| `env-probe.mjs` | 环境采集、缓存刷新、Git Bash/pwsh 工具 |
| `powershell-runtime.mjs` | 验证 PowerShell 版本、固定实际可执行文件 |
| `shell-workdir.mjs` | 工作目录校验、世界分派、POSIX 参数转义、失败阻断 |
| `instruction-hint.mjs` | 指令文件发现；专用 producer kind 与旧日志兼容 |
| `router-core.mjs` / `router-progressive.mjs` | 原有任务分类、模式提示和交付检查工具 |
| `wsl-bash.mjs` | Windows 下独立 WSL Bash 进程 |
| `skill-search.mjs` | 技能按需搜索和加载 |

## 不得破坏的约束

1. `persona.complete: false`：DSH 的 `complete:true` 会只保留 persona prefix，丢弃环境段和 waterfall 中追加的路由提示。`includeRuntimeContext:false` 只压制其他动态 runtime context，不影响本包系统 section。
2. 使用 `{{model}}` / `{{provider}}` 获取官方模型选择器的当前请求路由。不要改成 `agent.options.model`、上次请求 header 或首轮模型缓存。ID 无法揭示反向代理内部的模型映射。
3. DSH 在 `agent/pre-step` 前已 assemble；首次环境探测必须在 `system-prompt/assemble` 内等待。不要递归 assemble。环境事实通过变量单次插值，目录中的 `{{...}}` 必须保持原文。
4. 环境不再注入持久 user 消息，不会在重启、恢复或压缩时生成重复 `env-brief-*` ID。`env_probe` 主动刷新缓存供后续请求使用。
5. Git Bash 全局优先。需要 PowerShell、`.ps1`、Windows UI 自动化时调用 `pwsh` 工具：优先验证绑定 PowerShell 7，没有 7 才使用系统默认后端并显示实际版本。执行失败不能触发另一次隐式降级。
6. 工作目录必须为相应后端支持的绝对路径；显式空值、相对路径、NUL、未知世界直接报错。Git Bash 的 `cd -- <quoted>` 失败后绝不执行后续命令。不要恢复 SystemRoot 静默回退。
7. 平台 shell/editor 分派互斥；保留 `wsl-` 变体自禁用条件；服务行按需隔离 realm。
8. persona 前缀必须保留 `Reasoning language: think in Chinese (简体中文)` 这一条（v2.3.0 起）：中文思考由系统提示词强制，不依赖记忆或用户当场提醒。改写人设时不得删除，也不得因此把 `complete` 改成 `true`。
9. 工具门控纪律（v3.0.0 起）：
   - 裁剪只作用于 `system-prompt/assemble` 的 `tools`，不动 sections；`ctx.tools.schemas()` 必须保持全量，否则 `dev_tool_search` 搜不到被锁工具。
   - 门控工具 `dev_tool_search` 必须常驻且能注册成功；缺失时过滤器降级全量并只告警一次，宁可多花 token 也不锁死会话。
   - 解锁集合从持久 `tool/call` 事件重建，不要改成只存内存或依赖其它服务；压缩后靠内存状态继续，不重新扫描。
   - 子代理默认不裁剪（`includeSubagents: false`）；改成 `true` 前先确认子代理任务不依赖非常驻工具。
   - 调整 `residentTools` 时保持精简（当前 29 个）；每加一个常驻工具，所有会话每轮都要多付它的 schema。

## 安装

```bash
dsh plugin --profile web add "file:/absolute/path/to/this/repo"
```

使用对应宿主的官方插件管理 CLI 管理实际 profile。不要直接复制 `node_modules`，不要把子目录当作 profile 根目录。桌面 `desktop` 是保留 profile，使用桌面应用自带 CLI 管理，不要用普通 CLI boot 它。

安装是快照，`git pull` 后需重新安装并重启宿主。不要承诺源码修改会自动更新已安装副本。

## 校验

```bash
npm test
# 可选：使用本机 DSH 依赖执行真实 prompt registry / model-selection 集成测试
DSH_TEST_ANCHOR=/path/to/dsh npm test
```

- `node --check` 检查所有运行 `.mjs`。
- 离线组合 schema 校验使用本机工作区配套 `verify-dsh-preset-bundle.mjs`；它是补充，不替代真实 prompt 渲染测试。
- Windows 实机验证绑定路径、`$PSVersionTable.PSVersion`、中文输出和工具执行 cwd；不要为验证而重启用户当前会话。
- 发布前审阅 `git diff --check`、测试和 npm 包内容；上传版本号对应的包与校验和。
