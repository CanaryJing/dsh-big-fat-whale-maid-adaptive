# AI.md — 给 AI 看的项目构成与安装说明

> 本文件面向需要安装、维护、改造或诊断本预设的 AI 智能体。人类说明见 `README.md`。
> 本预设**单目录自包含**：不依赖 dsh-wsl-workspace 插件，不需要修改任何绝对路径。
>
> **工具策略（2026-09 起）**：全量工具一次性开放——无首轮锚定、无渐进披露、无按需解锁；所有已注册工具从第一轮起全部可见。

## 1. 项目构成

```
big-fat-whale-maid-adaptive/
├── agent.cordis.yml        # Agent-plane Cordis 组合（全量工具开放）
├── preset.yml              # 展示元数据：name / description / order
├── router-core.mjs         # 思维模式路由核心（纯函数库，无 apply，不作为插件装载）
├── router-progressive.mjs  # 任务模式路由 + delivery_check + dev_router_status（无工具门控）
├── compaction-epoch.mjs    # epoch 感知晋升追踪（instruction-hint 使用）
├── skill-search.mjs        # 技能搜索（anchored-standard 移植）
├── instruction-hint.mjs    # 指令文件短提示（anchored-standard 移植）
├── env-probe.mjs           # 环境探测 + 简报 + env_probe/gitbash/pwsh 工具（原创核心）
├── wsl-bash.mjs            # 自包含「bash 直达 WSL」工具（原创）
├── context-gate.mjs        # [已卸载·备查] 旧首轮注入门控
├── tool-bootstrap.mjs      # [已卸载·备查] 旧首轮锚定
├── dev-tool-search.mjs     # [已卸载·备查] 旧按需解锁
├── README.md               # 插件作用说明（给人看）
├── AI.md                   # 本文件：项目构成与安装说明（给 AI 看）
├── AIreadme.md             # 安装方法说明（给 AI / 维护者看）
└── CREDITS.md              # 改编来源与致谢（上游插件）
```

### 1.1 `agent.cordis.yml` 顶层行（按注册顺序）

| id | 类型 | 作用 |
|---|---|---|
| `router-progressive` | `./router-progressive.mjs` | 任务模式路由：注入 react/spec/weak 叠加句到 persona；注册 `dev_router_status` / `delivery_check`；**不做任何工具门控** |
| `env-probe` | `./env-probe.mjs` | 挂载时探测静态环境；每会话首轮注入英文**系统环境报告**（OS/内核/架构、CPU/内存、用户与 home/tmp、cwd 世界、shell 与路径规则；覆盖 Windows / Linux / WSL / macOS / Android）；注册 `env_probe` / `gitbash`（全环境第一优先）/ `pwsh` 工具 |
| `persona` | `@deepseek-ai/dsh-persona` | 女仆长人设 + 外貌设定 + 任务模式路由说明；`complete: true`、`includeRuntimeContext: false` |
| `instruction-hint` | `./instruction-hint.mjs` | 首次工具调用/回复后注入一次指令文件短提示（非命令式措辞，randomUUID 唯一 id，全链探测 AGENTS.md/CLAUDE.md） |
| `native-persistent-shell` | cordis:group，isolate `terminals` | 非 win32 提供 Minimal 同款持久 PTY bash（工具名 `bash`）；`disabled: win32` |
| `wsl-bash` | `./wsl-bash.mjs` | 仅 win32 启用；`disabled: !!js process.platform !== 'win32' \|\| /[\\/]wsl-/.test(baseUrl)` |
| `str-replace-editor` | 官方行（host fs） | 仅 win32 启用 + `wsl-` 自禁用；win32 上用宿主文件系统 |
| `bootstrap-filesystem` | cordis:group，isolate `fs` | 非 win32 提供 Minimal 同款 fs-local + str_replace_editor；`disabled: win32` |
| `tool-fs` | 官方行 | 全平台注册，走宿主文件系统（win32 上 WSL 文件经 UNC 访问） |
| `tool-fs-search` | 官方行 | 仅非 win32；win32 上故意不注册，WSL 侧用 bash find/grep |
| `tool-jobs` / `skill-filesystem` / `skill-search` / `tool-goal` | 官方行 + 移植行 | 宿主平面服务的模型面消费行，不放 realm |
| `planning` | cordis:group，isolate `planMode` | 计划模式 |
| `compaction` | cordis:group，isolate `compaction`+`toolResultPruner` | 压缩 + 工具结果裁剪 |
| `delegation` | cordis:group，isolate `workflowEngine` | subagent / subagent_fork / codex / claude-code（已启用）/ workflow / ralph |
| `tool-ask-user` / `tool-todo` / `tool-web` | 官方行 | 提问、待办、Web 搜索 |

### 1.2 关键设计约束（改造时不得破坏）

1. **全量工具开放**：组合中不得重新引入任何工具过滤插件（`context-gate` / `tool-bootstrap` / `dev-tool-search` 已卸载）；`router-progressive` 不得过滤 `assembled.tools`。
2. **平台分派互斥**：两组 bash/editor 提供者绝不可同时启用，否则报 `tool "bash" is already registered in this scope`。
3. **`wsl-` 变体自禁用**：`wsl-bash` 与顶层 `str-replace-editor` 的 disabled 表达式必须包含 `/[\\/]wsl-/.test(baseUrl)`。
4. **服务行必须带 isolate realm**；纯消费官方行不放 realm。
5. **本地 mjs 零外部依赖**：只允许 `node:` 内置模块 import。
6. **无任何机器相关路径**：本预设没有绝对路径行。
7. **`router-core.mjs` 是纯函数库**（无 `apply`），不作为插件装载，仅供 `router-progressive.mjs` 相对路径 import。

### 1.3 模块接口速查

- **`router-core.mjs`**：导出 `classifyTask(text)`（1=react / 0=spec / 'weak'）、`overlayFor(mode, modelId)`（任务模式叠加句）、`sessionEvents(session)`（snapshotEvents 兼容）、`sessionMode(session)`、`parseMode(token)`、`bandOf/bandFor/isFlashModel/isComplexTask/clamp01/applyPersona`。
- **`router-progressive.mjs`**：`name = 'whale-maid-router'`，`inject = ['systemPrompt', 'tools']`。注入任务模式叠加句；注册 `dev_router_status` / `delivery_check`；**无 STAGES、无 restrictTools、无 phase_advance**（全量开放）。
- **`compaction-epoch.mjs`**：`createEpochPromotion(promoteEvents, options)`——epoch 感知晋升追踪，供 `instruction-hint.mjs` 使用。
- **`env-probe.mjs`**：导出 `probeStatic(timeoutMs)`（async）、`worldOf(cwd)`、`buildBrief(snapshot, cwd, wslVariant)`。注册 `env_probe` / `gitbash`（win32，全环境第一优先）/ `pwsh`（win32 回退；非 win32 探测到才注册）。英文系统环境报告（含 OS / 硬件 / 用户 / cwd / shell）。
- **`wsl-bash.mjs`**：导出 `planFor(workdir, fallbackDistro, username)` 三态翻译；执行形状 `wsl.exe -d <distro> [--cd <linuxCwd>] -e bash -lc <command>`。

## 2. 安装方法（AI 执行手册）

1. **校验环境**：Windows 宿主需 `wsl.exe -l -q` 至少列出一个发行版（否则 bash 工具不注册，预设仍可运行）；Git for Windows 提供 `gitbash` 工具（全环境第一优先；缺失自动回退 pwsh）；Linux 宿主无额外要求。
2. **复制项目**（9 个运行文件）：
   ```powershell
   $dst = "$env:USERPROFILE\.dsh\.agent-presets\big-fat-whale-maid-adaptive"
   New-Item -ItemType Directory -Force -Path $dst | Out-Null
   Copy-Item agent.cordis.yml,preset.yml,router-core.mjs,router-progressive.mjs,compaction-epoch.mjs,skill-search.mjs,instruction-hint.mjs,env-probe.mjs,wsl-bash.mjs $dst -Force
   ```
   无需任何路径修改（自包含）。`context-gate.mjs` / `tool-bootstrap.mjs` / `dev-tool-search.mjs` 为已卸载旧机制（备查，可不复制）。
3. **验证清单（发布前）**：
   - `for f in *.mjs; do node --check "$f" || exit 1; done`；
   - 顶层 `- id:` 无重复；`name:` 行无绝对路径、无 dsh-wsl-workspace；
   - 组合中不含 context-gate / tool-bootstrap / dev-tool-search 行；
   - 平台分派与 `wsl-` 自禁用条件正确（见 1.2 第 2、3 条）；
   - import 链测试：`node -e "import('./router-core.mjs').then(m => console.log(typeof m.classifyTask))"` 等；
   - `planFor` 三态翻译正确；真实运行 `wsl.exe -d <distro> --cd /home/<user> -e bash -lc 'echo ok; uname -srm'` 成功；
   - 模拟 dsh-wsl-workspace 变体生成器（WORLD_ROWS = tool-bash/tool-pwsh/tool-fs/tool-fs-search/filesystem/persistent-shell）：win32 视角变体的活跃 bash/editor 提供者都恰好 1。
4. **生效**：重启 `dsh web`；新建会话选择该预设；第一轮即应看到**全量工具** + 英文**系统环境报告**（覆盖 Windows / Linux / WSL / macOS / Android）。

## 3. 常见故障诊断

| 症状 | 根因 | 修复 |
|---|---|---|
| `Invalid schema ... got 'type: null'` | 工具 `parameters` 是空对象 `{}` | 用 `toJsonSchema({})` 或显式 object-rooted JSON Schema |
| `tool "bash" is already registered in this scope` | 同层两个 bash 提供者 | 检查平台 disabled 互斥与 `/[\\/]wsl-/.test(baseUrl)` 自禁用 |
| 挂载报缺失 `./xxx.mjs` | 文件未复制 | 确认 9 个运行文件齐全 |
| Windows 上 bash 调用失败 `terminal inspection is unsupported` | 模型拿到的是 PTY 持久 bash（native-persistent-shell 未被 win32 禁用） | 复核 disabled 表达式 |
| bash 报 `workdir is not in any known world` | workdir 不是 UNC / Linux / 盘符三者之一 | 传入合法路径或让模型传绝对路径 |
| 工具不全 | 组合中重新引入了过滤插件，或工具行被平台 disabled | 本预设不做门控：检查行与 disabled 表达式 |
| 简报缺失 | pre-step 注入异常被静默跳过 | 查 host 日志 env-probe 警告；`env_probe` 工具可手动复查 |

## 4. 定制入口

- 改人设：`persona` 行 `prefix`（保持 `complete: true`）。
- 改路由：`router-core.mjs` 的 REACT_RE / SPEC_RE 关键词与叠加句。
- 改交付 gate：`router-progressive.mjs` 的 `delivery_check` 描述与校验逻辑。
- 改 WSL bash 行为：`wsl-bash` 行的 `config`（`distro`、`username`、`timeoutMs`、`maxOutputBytes`、`probeTimeoutMs`）。
- 加/减能力：增删顶层行；新增服务行必须带 isolate realm，纯消费行保持松散。
- 改显示名：`preset.yml`。
- 派生新预设：复制整个目录为新 id（`[a-z0-9][a-z0-9-]*`），改 `preset.yml` 后重启。
