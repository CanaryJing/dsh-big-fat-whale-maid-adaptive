# AI.md — 给 AI 看的项目构成与安装说明

> 本文件面向需要安装、维护、改造或诊断本预设的 AI 智能体。人类说明见 `README.md`。
> 本预设**单目录自包含**：不依赖 dsh-wsl-workspace 插件，不需要修改任何绝对路径。

## 1. 项目构成

```
big-fat-whale-maid-adaptive/
├── agent.cordis.yml        # Agent-plane Cordis 组合（顶层 24 行）
├── preset.yml              # 展示元数据：name / description / order
├── context-gate.mjs        # 统一注入门控（anchored-standard 移植，必须排第一）
├── compaction-epoch.mjs    # epoch 感知晋升追踪（context-gate / tool-bootstrap 共享）
├── tool-bootstrap.mjs      # 首轮锚定 + 压缩后回落（anchored-standard 改造版）
├── router-core.mjs         # 思维模式路由核心（纯函数库，无 apply，不作为插件装载）
├── router-progressive.mjs  # 四阶段渐进披露（router-standard v1.20 语义移植）
├── dev-tool-search.mjs     # 按需工具解锁（anchored-standard 移植）
├── skill-search.mjs        # 技能搜索（anchored-standard 移植）
├── instruction-hint.mjs    # 指令文件短提示（anchored-standard 移植）
├── env-probe.mjs           # 环境探测 + 简报 + env_probe/gitbash/pwsh 工具（原创核心）
└── wsl-bash.mjs            # 自包含「bash 直达 WSL」工具（原创）
```

### 1.1 `agent.cordis.yml` 顶层行（按注册顺序）

| id | 类型 | 作用 |
|---|---|---|
| `context-gate` | `./context-gate.mjs` | **必须排第一**。统一注入门控：未晋升时 blank runtime-context + pre-step claimed-baseline deny（allowKinds: skill-invocation）；晋升后打开；compaction/end 重关 |
| `tool-bootstrap` | `./tool-bootstrap.mjs` | 首轮只暴露 `bash + str_replace_editor`；晋升后放行全量（交给 router-progressive）；compaction 后回落到锚定对 + compactionTools；`promoteOn: either`；fail-open |
| `router-progressive` | `./router-progressive.mjs` | 晋升后四阶段渐进披露（预解锁归零）+ persona 叠加句注入 + 阶段持久化（`DSH_HOME/whale-maid-router/stages.json`）+ phase_advance / dev_router_status / tools_catalog / tools_help / delivery_check |
| `dev-tool-search` | `./dev-tool-search.mjs` | `dev_tool_search` 按名解锁工具（评分搜索）；解锁的工具立即可见（router-progressive 感知） |
| `env-probe` | `./env-probe.mjs` | 挂载时探测静态环境；每会话首轮注入英文环境简报；注册 `env_probe` / `gitbash` / `pwsh` 工具 |
| `persona` | `@deepseek-ai/dsh-persona` | 女仆长人设 + 外貌设定 + 任务模式路由说明；`complete: true`、`includeRuntimeContext: false` |
| `instruction-hint` | `./instruction-hint.mjs` | 晋升后注入一次指令文件短提示（非命令式措辞，randomUUID 唯一 id，全链探测 AGENTS.md/CLAUDE.md） |
| `native-persistent-shell` | cordis:group，isolate `terminals` | 非 win32 提供 Minimal 同款持久 PTY bash（工具名 `bash`）；`disabled: win32` |
| `wsl-bash` | `./wsl-bash.mjs` | 仅 win32 启用；`disabled: !!js process.platform !== 'win32' \|\| /[\\/]wsl-/.test(baseUrl)`（`wsl-` 自禁用让位给自动变体的 bash） |
| `str-replace-editor` | 官方行（host fs） | 仅 win32 启用 + `wsl-` 自禁用；win32 上用宿主文件系统（Windows 路径与 `\\wsl.localhost\<distro>\…` 均可） |
| `bootstrap-filesystem` | cordis:group，isolate `fs` | 非 win32 提供 Minimal 同款 fs-local + str_replace_editor；`disabled: win32` |
| `tool-fs` | 官方行 | 全平台注册，走宿主文件系统（win32 上 WSL 文件经 UNC 访问） |
| `tool-fs-search` | 官方行 | 仅非 win32；win32 上故意不注册（Windows ripgrep 读不了 WSL 路径），WSL 侧用 bash find/grep |
| `tool-jobs` / `skill-filesystem` / `skill-search` / `tool-goal` | 官方行 + 移植行 | 宿主平面服务的模型面消费行，不放 realm |
| `planning` | cordis:group，isolate `planMode` | 计划模式 |
| `compaction` | cordis:group，isolate `compaction`+`toolResultPruner` | 压缩 + 工具结果裁剪 |
| `delegation` | cordis:group，isolate `workflowEngine` | subagent / subagent_fork / codex / claude-code（已启用）/ workflow / ralph |
| `tool-ask-user` / `tool-todo` / `tool-web` | 官方行 | 提问、待办、Web 搜索 |

### 1.2 关键设计约束（改造时不得破坏）

1. **bootstrapTools 必须正好是 `[bash, str_replace_editor]`**，且两个名字在目标平台必须有注册者：
   - win32：`bash` 由 `wsl-bash` 行提供，`str_replace_editor` 由顶层 editor 行提供；
   - 非 win32：`bash` 由 `native-persistent-shell` 提供，`str_replace_editor` 由 `bootstrap-filesystem` 提供。
2. **行序**：`context-gate` 第一、`tool-bootstrap` 第二（waterfall reverse-order 依赖）；`router-core.mjs` 是**纯函数库**（无 `apply`），**不作为插件装载**，仅供 `router-progressive.mjs` 相对路径 import。
3. **平台分派互斥**：两组 bash/editor 提供者绝不可同时启用，否则报 `tool "bash" is already registered in this scope`。
4. **`wsl-` 变体自禁用**：`wsl-bash` 与顶层 `str-replace-editor` 的 disabled 表达式必须包含 `/[\\/]wsl-/.test(baseUrl)`——当本目录被复制成 `wsl-*` 变体时（dsh-wsl-workspace 的生成器会为每个源预设生成变体并把 bash/editor 替换为它自己的 WSL 实现），这两行必须自动让位，否则变体双注册冲突。
5. **服务行必须带 isolate realm**：`native-persistent-shell`（terminals）、`bootstrap-filesystem`（fs）；纯消费官方行不放 realm。
6. **本地 mjs 零外部依赖**：用户 home 下的 preset 无法解析 harness 的 `@deepseek-ai/*` 包，全部 `.mjs` 只允许 `node:` 内置模块 import。
7. **无任何机器相关路径**：本预设没有绝对路径行；安装到任何机器都无需改配置。
8. **阶段状态目录**：`router-progressive` 持久化到 `DSH_HOME/whale-maid-router/stages.json`（与 router-standard 的 `router-standard/stages.json` 隔离，避免跨预设串档）。

### 1.3 模块接口速查

- **`router-core.mjs`**：导出 `classifyTask(text)`（1=react / 0=spec / 'weak'）、`overlayFor(mode, modelId)`（任务模式叠加句，Flash 模型 weak 带三锚）、`sessionEvents(session)`（snapshotEvents 兼容）、`advanceStage(stage, toolNames, text)`、`parseMode(token)`、`bandOf/bandFor/isFlashModel/isComplexTask/clamp01/applyPersona`。
- **`router-progressive.mjs`**：`name = 'whale-maid-router-progressive'`，`inject = ['systemPrompt', 'tools']`。四阶段 STAGES（阶段 0 含锚定工具 + discovery 工具）；`windowFor(stage) = stage+1`（预解锁归零，v1.20 语义）；晋升检测与 tool-bootstrap 的 `promoteOn: either` 同源；`restrictTools` 放行 `dev_tool_search` 解锁的工具；注册 phase_advance / dev_router_status / tools_catalog / tools_help / delivery_check。
- **`tool-bootstrap.mjs`**：`name = 'anchored-tool-bootstrap'`，依赖 `./compaction-epoch.mjs`。晋升后**返回全量**（router-progressive 接管渐进披露）；compaction 后回落到锚定对 + compactionTools。
- **`context-gate.mjs`**：`name = 'anchored-context-gate'`，依赖 `./compaction-epoch.mjs`。两条注入路径（system-prompt/assemble contexts blanking + agent/pre-step claimed-baseline deny）。
- **`env-probe.mjs`**：导出 `probeStatic(timeoutMs)`（async）、`worldOf(cwd)`、`buildBrief(snapshot, cwd, wslVariant)`。注册 `env_probe` / `gitbash`（win32，Windows 侧默认）/ `pwsh`（win32 回退；非 win32 探测到才注册）。英文简报。
- **`wsl-bash.mjs`**：导出 `planFor(workdir, fallbackDistro, username)` 三态翻译；执行形状 `wsl.exe -d <distro> [--cd <linuxCwd>] -e bash -lc <command>`。

## 2. 安装方法（AI 执行手册）

1. **校验环境**：Windows 宿主需 `wsl.exe -l -q` 至少列出一个发行版（否则 bash 工具不注册，预设仍可运行但降级全量目录）；Git for Windows 提供 `gitbash` 工具（缺失自动回退 pwsh）；Linux 宿主无额外要求。
2. **复制项目**（12 个文件）：
   ```powershell
   $dst = "$env:USERPROFILE\.dsh\.agent-presets\big-fat-whale-maid-adaptive"
   New-Item -ItemType Directory -Force -Path $dst | Out-Null
   Copy-Item agent.cordis.yml,preset.yml,context-gate.mjs,compaction-epoch.mjs,tool-bootstrap.mjs,router-core.mjs,router-progressive.mjs,dev-tool-search.mjs,skill-search.mjs,instruction-hint.mjs,env-probe.mjs,wsl-bash.mjs $dst -Force
   ```
   无需任何路径修改（自包含）。
3. **验证清单（发布前）**：
   - `for f in *.mjs; do node --check "$f" || exit 1; done`；
   - 顶层 `- id:` 无重复（24 行）；`name:` 行无绝对路径、无 dsh-wsl-workspace；
   - 行序：context-gate 第一、tool-bootstrap 第二；router-core.mjs 是纯函数库（无 apply），不作为插件装载；
   - `bootstrapTools` 为 `[bash, str_replace_editor]`；`includeSubagents: true` 两处同步；
   - 平台分派与 `wsl-` 自禁用条件正确（见 1.2 第 3、4 条）；
   - import 链测试：`node -e "import('./router-core.mjs').then(m => console.log(typeof m.classifyTask))"` 等四个模块；
   - `planFor` 三态翻译正确；真实运行 `wsl.exe -d <distro> --cd /home/<user> -e bash -lc 'echo ok; uname -srm'` 成功；
   - 模拟 dsh-wsl-workspace 变体生成器（WORLD_ROWS = tool-bash/tool-pwsh/tool-fs/tool-fs-search/filesystem/persistent-shell）：win32 视角变体的活跃 bash/editor 提供者都恰好 1。
4. **生效**：重启 `dsh web`；新建会话选择该预设；首轮应只见 `bash + str_replace_editor` + 英文环境简报；晋升后进入渐进披露阶段 0。

## 3. 常见故障诊断

| 症状 | 根因 | 修复 |
|---|---|---|
| `Invalid schema ... got 'type: null'` | 工具 `parameters` 是空对象 `{}` | 用 `toJsonSchema({})` 或显式 object-rooted JSON Schema |
| `tool "bash" is already registered in this scope` | 同层两个 bash 提供者（win32 上 wsl-bash 与持久 shell 同时启用，或 `wsl-*` 变体未让位） | 检查平台 disabled 互斥与 `/[\\/]wsl-/.test(baseUrl)` 自禁用 |
| 挂载报缺失 `./xxx.mjs` | 文件未复制 | 确认 12 个文件齐全 |
| Windows 上 bash 调用失败 `terminal inspection is unsupported` | 模型拿到的是 PTY 持久 bash（native-persistent-shell 未被 win32 禁用） | 复核 disabled 表达式 |
| bash 报 `workdir is not in any known world` | workdir 不是 UNC / Linux / 盘符三者之一 | 传入合法路径或让模型传绝对路径 |
| 首轮没有锚定、直接全量工具 | bootstrapTools 中某工具缺失触发 fail-open | 检查目标平台 bash / str_replace_editor 提供者 |
| 简报缺失 | pre-step 注入异常被静默跳过 | 查 host 日志 env-probe 警告；`env_probe` 工具可手动复查 |
| 晋升后工具很少 | 渐进披露阶段限制 | `dev_router_status` 查阶段；`phase_advance` 推进；`dev_tool_search` 按名解锁 |
| 阶段状态串档 | 与 router-standard 共用 stages.json | 本预设用独立目录 `whale-maid-router/stages.json`，勿改回 |

## 4. 定制入口

- 改人设：`persona` 行 `text`（保持 `complete: true`）。
- 改锚定：`tool-bootstrap` 的 `bootstrapTools` / `promoteOn`（`either` / `tool-call` / `assistant-message`）/ `compactionTools` / `includeSubagents`。
- 改路由：`router-core.mjs` 的 REACT_RE / SPEC_RE 关键词与叠加句；`router-progressive.mjs` 的 STAGES / STAGE_GUIDES / `windowFor`（放宽预放改 `stage+1` 为 `stage+3`）。
- 改 WSL bash 行为：`wsl-bash` 行的 `config`（`distro`、`username`、`timeoutMs`、`maxOutputBytes`、`probeTimeoutMs`）。
- 加/减能力：增删顶层行；新增服务行必须带 isolate realm，纯消费行保持松散。
- 改显示名：`preset.yml`。
- 派生新预设：复制整个目录为新 id（`[a-z0-9][a-z0-9-]*`），改 `preset.yml` 后重启。
