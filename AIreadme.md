# AIreadme.md — 安装方法（给 AI / 维护者）

> 本文件是「大肥鱼女仆长 · 环境自适应模式」的**安装手册**，面向需要安装、维护、改造或诊断本预设的 AI 智能体与开发者。插件作用说明见 [README.md](./README.md)。
>
> 本预设**单目录自包含**：不依赖 dsh-wsl-workspace 插件，不需要修改任何绝对路径。

---

## 1. 前置条件

- 已安装 DSH CLI 与 `dsh web`。
- Windows 宿主若想使用「bash 直达 WSL」功能，需至少安装一个 WSL 发行版（例如 `wsl --install -d kali-linux`），且 `wsl.exe -l -q` 能列出发行版。
- Windows 宿主若想使用 `gitbash` 工具（Windows 侧默认 shell），需安装 Git for Windows（探测顺序：`Program Files\Git\bin\bash.exe` → `Program Files (x86)` → 每用户 `LOCALAPPDATA\Programs\Git`）；未安装时自动回退 `pwsh`。
- Linux 宿主无额外要求；如希望 `pwsh` 工具可用，可自行安装 PowerShell。
- 无需安装任何 npm 依赖：全部 `.mjs` 只使用 `node:` 内置模块。

---

## 2. 安装步骤

### 2.1 Windows 宿主（PowerShell）

```powershell
$src  = "$PWD\big-fat-whale-maid-adaptive"   # 或填写本项目实际路径
$dst  = "$env:USERPROFILE\.dsh\.agent-presets\big-fat-whale-maid-adaptive"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item "$src\agent.cordis.yml", "$src\preset.yml", `
  "$src\context-gate.mjs", "$src\compaction-epoch.mjs", "$src\tool-bootstrap.mjs", `
  "$src\router-core.mjs", "$src\router-progressive.mjs", `
  "$src\dev-tool-search.mjs", "$src\skill-search.mjs", "$src\instruction-hint.mjs", `
  "$src\env-probe.mjs", "$src\wsl-bash.mjs" $dst -Force
```

### 2.2 Linux 宿主（bash）

```bash
SRC="$PWD/big-fat-whale-maid-adaptive"        # 或填写本项目实际路径
DST="$HOME/.dsh/.agent-presets/big-fat-whale-maid-adaptive"
mkdir -p "$DST"
cp "$SRC"/agent.cordis.yml "$SRC"/preset.yml \
   "$SRC"/context-gate.mjs "$SRC"/compaction-epoch.mjs "$SRC"/tool-bootstrap.mjs \
   "$SRC"/router-core.mjs "$SRC"/router-progressive.mjs \
   "$SRC"/dev-tool-search.mjs "$SRC"/skill-search.mjs "$SRC"/instruction-hint.mjs \
   "$SRC"/env-probe.mjs "$SRC"/wsl-bash.mjs "$DST"/
```

### 2.3 生效

重启 `dsh web`，新建会话并在模式选择器中选择「**大肥鱼女仆长 · 环境自适应模式**」。

> 注意：只复制插件运行所需的 **12 个文件**即可；`README.md`、`AI.md` 与 `AIreadme.md` 是文档，可选择性复制。

---

## 3. 安装后验证清单

发布或安装前逐项检查：

- [ ] 全部 `.mjs` 语法检查通过：
  ```bash
  for f in *.mjs; do node --check "$f" || exit 1; done
  ```
- [ ] `agent.cordis.yml` 顶层 `- id:` 无重复（共 24 行）；`name:` 行无绝对路径、无 `dsh-wsl-workspace` 依赖。
- [ ] 行序正确：`context-gate` 必须排第一，`tool-bootstrap` 第二，`router-core` / `router-progressive` / `dev-tool-search` 在 `env-probe` 之前。
- [ ] `bootstrapTools` 为 `[bash, str_replace_editor]`；`compactionTools` 为 `[read, write, edit, glob, grep, todo_write, ask_user_question]`。
- [ ] `context-gate` 与 `tool-bootstrap` 的 `includeSubagents: true` 保持同步。
- [ ] 平台分派互斥：win32 与非 win32 各只有一组 bash/editor 提供者；`wsl-bash` 与顶层 `str-replace-editor` 的 disabled 表达式包含 `/[\\/]wsl-/.test(baseUrl)` 自禁用。
- [ ] 服务行带 isolate realm：`native-persistent-shell`（terminals）、`bootstrap-filesystem`（fs）。
- [ ] import 链测试通过：
  ```bash
  node -e "import('./router-core.mjs').then(m => console.log(typeof m.classifyTask, typeof m.sessionEvents, typeof m.overlayFor))"
  node -e "import('./router-progressive.mjs').then(m => console.log(m.name))"
  node -e "import('./tool-bootstrap.mjs').then(m => console.log(m.name))"
  node -e "import('./context-gate.mjs').then(m => console.log(m.name))"
  ```
- [ ] 真实运行 WSL bash 冒烟测试成功：
  ```bash
  wsl.exe -d <distro> --cd /home/<user> -e bash -lc 'echo ok; uname -srm'
  ```
- [ ] 重启后新建会话，首轮应只见 `bash + str_replace_editor` + 英文环境简报；首次工具调用/回复后进入渐进披露阶段 0（了解/对齐）。

---

## 4. 项目构成

```
big-fat-whale-maid-adaptive/
├── agent.cordis.yml        # Agent-plane Cordis 组合（顶层 24 行）
├── preset.yml              # 展示元数据：name / description / order
├── context-gate.mjs        # 统一注入门控（anchored-standard 移植，必须排第一）
├── compaction-epoch.mjs    # epoch 感知晋升追踪（context-gate / tool-bootstrap 共享）
├── tool-bootstrap.mjs      # 首轮锚定 + 压缩后回落（anchored-standard 改造版）
├── router-core.mjs         # 思维模式路由核心（router-standard 移植）
├── router-progressive.mjs  # 四阶段渐进披露（router-standard v1.20 语义移植）
├── dev-tool-search.mjs     # 按需工具解锁（anchored-standard 移植）
├── skill-search.mjs        # 技能搜索（anchored-standard 移植）
├── instruction-hint.mjs    # 指令文件短提示（anchored-standard 移植）
├── env-probe.mjs           # 环境探测 + 简报 + env_probe/gitbash/pwsh 工具（原创核心）
├── wsl-bash.mjs            # 自包含「bash 直达 WSL」工具（原创）
├── README.md               # 插件作用说明（给人看）
├── AI.md                   # 面向 AI 的项目构成与安装说明
├── AIreadme.md             # 本文件：安装方法说明（给 AI / 维护者看）
└── CREDITS.md              # 改编来源与致谢（上游插件）
```

### 4.1 `agent.cordis.yml` 顶层行（按注册顺序）

| id | 类型 | 作用 |
|---|---|---|
| `context-gate` | `./context-gate.mjs` | **必须排第一**。统一注入门控：未晋升时 blank runtime-context + pre-step claimed-baseline deny（allowKinds: skill-invocation）；晋升后打开；compaction/end 重关 |
| `tool-bootstrap` | `./tool-bootstrap.mjs` | 首轮只暴露 `bash + str_replace_editor`；晋升后放行全量（交给 router-progressive）；compaction 后回落到锚定对 + compactionTools；`promoteOn: either`；fail-open |
| `router-core` | `./router-core.mjs` | 思维模式路由核心：classifyTask / overlayFor / sessionEvents / advanceStage / parseMode |
| `router-progressive` | `./router-progressive.mjs` | 晋升后四阶段渐进披露（预解锁归零）+ persona 叠加句注入 + 阶段持久化（`DSH_HOME/whale-maid-router/stages.json`）+ phase_advance / dev_router_status / tools_catalog / tools_help / delivery_check |
| `dev-tool-search` | `./dev-tool-search.mjs` | `dev_tool_search` 按名解锁工具（评分搜索）；解锁的工具立即可见（router-progressive 感知） |
| `env-probe` | `./env-probe.mjs` | 挂载时探测静态环境；每会话首轮注入英文环境简报；注册 `env_probe` / `gitbash` / `pwsh` 工具 |
| `persona` | `@deepseek-ai/dsh-persona` | 女仆长人设 + 外貌设定 + 任务模式路由说明；`complete: true`、`includeRuntimeContext: false` |
| `instruction-hint` | `./instruction-hint.mjs` | 晋升后注入一次指令文件短提示（非命令式措辞，randomUUID 唯一 id，全链探测 AGENTS.md/CLAUDE.md） |
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

### 4.2 关键设计约束（改造时不得破坏）

1. **bootstrapTools 必须正好是 `[bash, str_replace_editor]`**，且两个名字在目标平台必须有注册者。
2. **行序**：`context-gate` 第一、`tool-bootstrap` 第二（waterfall reverse-order 依赖）；`router-core` 必须在 `router-progressive` 之前（import 链）。
3. **平台分派互斥**：两组 bash/editor 提供者绝不可同时启用，否则报 `tool "bash" is already registered in this scope`。
4. **`wsl-` 变体自禁用**：`wsl-bash` 与顶层 `str-replace-editor` 的 disabled 表达式必须包含 `/[\\/]wsl-/.test(baseUrl)`。
5. **服务行必须带 isolate realm**；纯消费官方行不放 realm。
6. **本地 mjs 零外部依赖**：只允许 `node:` 内置模块 import。
7. **无任何机器相关路径**：本预设没有绝对路径行。
8. **阶段状态目录**：`router-progressive` 持久化到 `DSH_HOME/whale-maid-router/stages.json`（与 router-standard 的 `router-standard/stages.json` 隔离，避免跨预设串档）。

### 4.3 模块接口速查

- **`router-core.mjs`**：导出 `classifyTask(text)`（1=react / 0=spec / 'weak'）、`overlayFor(mode, modelId)`（任务模式叠加句）、`sessionEvents(session)`（snapshotEvents 兼容）、`advanceStage(stage, toolNames, text)`、`parseMode(token)`、`bandOf/bandFor/isFlashModel/isComplexTask/clamp01/applyPersona`。
- **`router-progressive.mjs`**：`name = 'whale-maid-router-progressive'`，`inject = ['systemPrompt', 'tools']`。四阶段 STAGES（阶段 0 含锚定工具 + discovery 工具）；`windowFor(stage) = stage+1`（预解锁归零）；晋升检测与 tool-bootstrap 的 `promoteOn: either` 同源；`restrictTools` 放行 `dev_tool_search` 解锁的工具。
- **`tool-bootstrap.mjs`**：`name = 'anchored-tool-bootstrap'`，依赖 `./compaction-epoch.mjs`。晋升后**返回全量**（router-progressive 接管渐进披露）；compaction 后回落到锚定对 + compactionTools。
- **`context-gate.mjs`**：`name = 'anchored-context-gate'`，依赖 `./compaction-epoch.mjs`。两条注入路径（system-prompt/assemble contexts blanking + agent/pre-step claimed-baseline deny）。
- **`env-probe.mjs`**：导出 `probeStatic(timeoutMs)`（async）、`worldOf(cwd)`、`buildBrief(snapshot, cwd, wslVariant)`。注册 `env_probe` / `gitbash`（win32，Windows 侧默认）/ `pwsh`（win32 回退；非 win32 探测到才注册）。英文简报。
- **`wsl-bash.mjs`**：导出 `planFor(workdir, fallbackDistro, username)` 三态翻译；执行形状 `wsl.exe -d <distro> [--cd <linuxCwd>] -e bash -lc <command>`。

---

## 5. 常见故障诊断

| 症状 | 根因 | 修复 |
|---|---|---|
| `Invalid schema ... got 'type: null'` | 工具 `parameters` 是空对象 `{}` | 用 `toJsonSchema({})` 或显式 object-rooted JSON Schema |
| `tool "bash" is already registered in this scope` | 同层两个 bash 提供者 | 检查平台 disabled 互斥与 `/[\\/]wsl-/.test(baseUrl)` 自禁用 |
| 挂载报缺失 `./xxx.mjs` | 文件未复制 | 确认 12 个文件齐全 |
| Windows 上 bash 调用失败 `terminal inspection is unsupported` | 模型拿到的是 PTY 持久 bash（native-persistent-shell 未被 win32 禁用） | 复核 disabled 表达式 |
| bash 报 `workdir is not in any known world` | workdir 不是 UNC / Linux / 盘符三者之一 | 传入合法路径或让模型传绝对路径 |
| pwsh 在 WSL 工作区里 spawn 失败 | 旧版把 Linux/UNC workdir 直接当 Windows 进程 cwd | 已修复（v3）：非盘符路径兜底 `%SystemRoot%`；命令内可用 `Set-Location` 切换目录 |
| 首轮没有锚定、直接全量工具 | bootstrapTools 中某工具缺失触发 fail-open | 检查目标平台 bash / str_replace_editor 提供者 |
| 简报缺失 | pre-step 注入异常被静默跳过 | 查 host 日志 env-probe 警告；`env_probe` 工具可手动复查 |
| 晋升后工具很少 | 渐进披露阶段限制 | `dev_router_status` 查阶段；`phase_advance` 推进；`dev_tool_search` 按名解锁 |
| 阶段状态串档 | 与 router-standard 共用 stages.json | 本预设用独立目录 `whale-maid-router/stages.json`，勿改回 |

---

## 6. 定制入口

- 改人设：`persona` 行 `text`（保持 `complete: true`）。
- 改锚定：`tool-bootstrap` 的 `bootstrapTools` / `promoteOn` / `compactionTools` / `includeSubagents`。
- 改路由：`router-core.mjs` 的 REACT_RE / SPEC_RE 关键词与叠加句；`router-progressive.mjs` 的 STAGES / STAGE_GUIDES / `windowFor`（放宽预放改 `stage+1` 为 `stage+3`）。
- 改 WSL bash 行为：`wsl-bash` 行的 `config`（`distro`、`username`、`timeoutMs`、`maxOutputBytes`、`probeTimeoutMs`）。
- 加/减能力：增删顶层行；新增服务行必须带 isolate realm，纯消费行保持松散。
- 改显示名：`preset.yml`。
- 派生新预设：复制整个目录为新 id（`[a-z0-9][a-z0-9-]*`），改 `preset.yml` 后重启。
