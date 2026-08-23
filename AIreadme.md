# AIreadme.md — 安装方法（给 AI / 维护者）

> 本文件是「大肥鱼女仆长 · 环境自适应模式」的**安装手册**，面向需要安装、维护、改造或诊断本预设的 AI 智能体与开发者。插件作用说明见 [readme.md](./readme.md)。
>
> 本预设**单目录自包含**：不依赖 dsh-wsl-workspace 插件，不需要修改任何绝对路径。

---

## 1. 前置条件

- 已安装 DSH CLI 与 `dsh web`。
- Windows 宿主若想使用「bash 直达 WSL」功能，需至少安装一个 WSL 发行版（例如 `wsl --install -d kali-linux`），且 `wsl.exe -l -q` 能列出发行版。
- Linux 宿主无额外要求；如希望 `pwsh` 工具可用，可自行安装 PowerShell。
- 无需安装任何 npm 依赖：三个 `.mjs` 只使用 `node:` 内置模块。

---

## 2. 安装步骤

### 2.1 Windows 宿主（PowerShell）

```powershell
$src  = "$PWD\big-fat-whale-maid-adaptive"   # 或填写本项目实际路径
$dst  = "$env:USERPROFILE\.dsh\.agent-presets\big-fat-whale-maid-adaptive"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item "$src\agent.cordis.yml", "$src\preset.yml", "$src\tool-bootstrap.mjs", "$src\env-probe.mjs", "$src\wsl-bash.mjs" $dst -Force
```

### 2.2 Linux 宿主（bash）

```bash
SRC="$PWD/big-fat-whale-maid-adaptive"        # 或填写本项目实际路径
DST="$HOME/.dsh/.agent-presets/big-fat-whale-maid-adaptive"
mkdir -p "$DST"
cp "$SRC"/agent.cordis.yml "$SRC"/preset.yml "$SRC"/tool-bootstrap.mjs "$SRC"/env-probe.mjs "$SRC"/wsl-bash.mjs "$DST"/
```

### 2.3 生效

重启 `dsh web`，新建会话并在模式选择器中选择「**大肥鱼女仆长 · 环境自适应模式**」。

> 注意：只复制插件运行所需的 5 个文件即可；`readme.md` 与 `AIreadme.md` 是文档，可选择性复制。

---

## 3. 安装后验证清单

发布或安装前逐项检查：

- [ ] 三个 `.mjs` 语法检查通过：
  ```bash
  node --check tool-bootstrap.mjs
  node --check env-probe.mjs
  node --check wsl-bash.mjs
  ```
- [ ] `agent.cordis.yml` 顶层 `- id:` 无重复；`name:` 行无绝对路径、无 `dsh-wsl-workspace` 依赖。
- [ ] `bootstrapTools` 为 `[bash, str_replace_editor]`。
- [ ] 平台分派互斥：win32 与非 win32 各只有一组 bash/editor 提供者；`wsl-bash` 与顶层 `str-replace-editor` 的 disabled 表达式包含 `/[\\/]wsl-/.test(baseUrl)` 自禁用。
- [ ] 服务行带 isolate realm：`native-persistent-shell`（terminals）、`bootstrap-filesystem`（fs）。
- [ ] 真实运行 WSL bash 冒烟测试成功：
  ```bash
  wsl.exe -d <distro> --cd /home/<user> -e bash -lc 'echo ok; uname -srm'
  ```
- [ ] 重启后新建会话，首轮应只见 `bash + str_replace_editor` + 环境简报，首次工具调用/回复后晋升全量工具。

---

## 4. 项目构成

```
big-fat-whale-maid-adaptive/
├── agent.cordis.yml      # Agent-plane Cordis 组合（顶层 20 行）
├── preset.yml            # 展示元数据：name / description / order
├── tool-bootstrap.mjs    # 锚定引导插件（anchored-standard 实现）
├── env-probe.mjs         # 环境探测插件（原创核心）
├── wsl-bash.mjs          # 自包含「bash 直达 WSL」工具插件（原创）
├── readme.md             # 插件作用说明（给人看）
├── AIreadme.md           # 本文件：安装方法说明（给 AI / 维护者看）
└── CREDITS.md            # 改编来源与致谢（上游插件）
```

### 4.1 `agent.cordis.yml` 顶层行（按注册顺序）

| id | 类型 | 作用 |
|---|---|---|
| `tool-bootstrap` | `./tool-bootstrap.mjs` | 必须排第一。首轮只暴露 `bash + str_replace_editor`，抑制 `agent-instructions` 与 `skill-catalog` 注入；`promoteOn: either`；bootstrap 工具缺失时 fail-open 到全量目录 |
| `env-probe` | `./env-probe.mjs` | 挂载时探测静态环境；每会话首轮注入环境简报（source kind `env-probe`）；注册 `env_probe` 工具；按探测结果注册 `pwsh` 工具（win32=Windows 母系统 PowerShell；非 win32=原生 pwsh 或 powershell.exe interop） |
| `persona` | `@deepseek-ai/dsh-persona` | 女仆长人设 + 外貌设定；`complete: true`、`includeRuntimeContext: false` |
| `agent-instructions` | `@deepseek-ai/dsh-agent-instructions` | 晋升后注入 AGENTS.md 摘要 |
| `native-persistent-shell` | cordis:group，isolate `terminals` | 非 win32 提供 Minimal 同款持久 PTY bash（工具名 `bash`）；`disabled: win32` |
| `wsl-bash` | `./wsl-bash.mjs` | 仅 win32 启用；`disabled: !!js process.platform !== 'win32' \|\| /[\\/]wsl-/.test(baseUrl)` |
| `str-replace-editor` | 官方行（host fs） | 仅 win32 启用 + `wsl-` 自禁用；win32 上用宿主文件系统 |
| `bootstrap-filesystem` | cordis:group，isolate `fs` | 非 win32 提供 Minimal 同款 fs-local + str_replace_editor；`disabled: win32` |
| `tool-fs` | 官方行 | 全平台注册，走宿主文件系统（win32 上 WSL 文件经 UNC 访问） |
| `tool-fs-search` | 官方行 | 仅非 win32；win32 上故意不注册，WSL 侧用 bash find/grep |
| `tool-jobs` / `skill-filesystem` / `tool-skill` / `tool-goal` | 官方行 | 宿主平面服务的模型面消费行，不放 realm |
| `planning` | cordis:group，isolate `planMode` | 计划模式 |
| `compaction` | cordis:group，isolate `compaction`+`toolResultPruner` | 压缩 + 工具结果裁剪 |
| `delegation` | cordis:group，isolate `workflowEngine` | subagent / subagent_fork / codex / claude-code（已启用）/ workflow / ralph |
| `tool-ask-user` / `tool-todo` / `tool-web` | 官方行 | 提问、待办、Web 搜索 |

### 4.2 关键设计约束（改造时不得破坏）

1. **bootstrapTools 必须正好是 `[bash, str_replace_editor]`**，且两个名字在目标平台必须有注册者。
2. **平台分派互斥**：两组 bash/editor 提供者绝不可同时启用，否则报 `tool "bash" is already registered in this scope`。
3. **`wsl-` 变体自禁用**：`wsl-bash` 与顶层 `str-replace-editor` 的 disabled 表达式必须包含 `/[\\/]wsl-/.test(baseUrl)`。
4. **服务行必须带 isolate realm**；纯消费官方行不放 realm。
5. **本地 mjs 零外部依赖**：只允许 `node:` 内置模块 import。
6. **无任何机器相关路径**：本预设没有绝对路径行。

### 4.3 `wsl-bash.mjs` 接口

- `export const name / inject = ['tools','subprocess'] / apply(ctx, config)`
- 导出测试函数 `planFor(workdir, fallbackDistro, username)`：三态翻译
  - `\\wsl.localhost\<distro>\…`（或 `\\wsl$\…`）→ 取 distro 与 Linux 路径；
  - `/…` Linux 路径 → fallbackDistro，`windowsCwd` 回退 `SystemRoot`；
  - `C:\…` → `/mnt/<drive>/…`，`windowsCwd` 用原 Windows 路径。
- 执行形状：`wsl.exe -d <distro> [--cd <linuxCwd>] -e bash -lc <command>`；每次独立进程；输出有界；非零退出抛错。
- 挂载时解析默认发行版：`config.distro` > Lxss 注册表默认 > `wsl.exe -l -q` 第一项；全部失败则**不注册 bash**（fail-open），绝不抛错。

### 4.4 `env-probe.mjs` 接口（v3）

- 导出测试函数：`probeStatic(timeoutMs)`（**async，返回 Promise**）、`worldOf(cwd)`、`buildBrief(snapshot, cwd, wslVariant = false)`
- `probeStatic`：platform + insideWsl（/proc/version + WSL_DISTRO_NAME）+ `wsl.exe -l -q` + Lxss 注册表默认发行版（Windows）；win32 上探测 Windows 母系统 PowerShell（P4 扩展路径：Program Files 7 / 7-preview、每用户 Programs、WindowsApps 执行别名，5.1 兜底）；Linux 上探测 pwsh / WSL 内 powershell.exe interop / wine。失败一律降级。**全部异步**（`execFile` + `Promise.all`），挂载时探测不阻塞启动，`env_probe` 工具调用不阻塞事件循环。
- `worldOf`：UNC → wsl 世界；`/…` → linux；`X:\…` → windows（附 `/mnt/x/…` 换算）。
- `buildBrief` 第三参 `wslVariant`：为 true（`ctx.baseUrl` 含 `/wsl-`，即 dsh-wsl-workspace 变体）时，简报把 bash 描述为持久 shell、文件工具描述为 WSL 文件系统世界，避免误导模型。
- pre-step 每会话注入一次简报（`source.kind = 'env-probe'`，Set 去重，异常静默跳过；等待挂载探测完成后注入）。
- `env_probe` 工具：无参数但必须 object-rooted JSON Schema（**勿改回 `{}`**）；实测 bash/pwsh 两侧，冒烟并行执行。
- `pwsh` 工具：按探测结果注册——win32 上为 Windows 母系统 PowerShell（优先 `pwsh.exe`，兜底 `powershell.exe`）；非 win32 上 WSL 内优先 Linux 原生 pwsh，其次 `powershell.exe` interop。**workdir 只接受 Windows 盘符路径**（`C:\…`），Linux/UNC 路径对 Windows PowerShell 进程不可靠，统一兜底到 `%SystemRoot%`（与 `wsl-bash` 同策略）。

---

## 5. 常见故障诊断

| 症状 | 根因 | 修复 |
|---|---|---|
| `Invalid schema ... got 'type: null'` | 工具 `parameters` 是空对象 `{}` | 用 `toJsonSchema({})` 或显式 object-rooted JSON Schema |
| `tool "bash" is already registered in this scope` | 同层两个 bash 提供者 | 检查平台 disabled 互斥与 `/[\\/]wsl-/.test(baseUrl)` 自禁用 |
| 挂载报缺失 `./wsl-bash.mjs` | 文件未复制 | 确认 5 个文件齐全 |
| Windows 上 bash 调用失败 `terminal inspection is unsupported` | 模型拿到的是 PTY 持久 bash（native-persistent-shell 未被 win32 禁用） | 复核 disabled 表达式 |
| bash 报 `workdir is not in any known world` | workdir 不是 UNC / Linux / 盘符三者之一 | 传入合法路径或让模型传绝对路径 |
| pwsh 在 WSL 工作区里 spawn 失败 | 旧版把 Linux/UNC workdir 直接当 Windows 进程 cwd | 已修复（v3）：非盘符路径兜底 `%SystemRoot%`；命令内可用 `Set-Location` 切换目录 |
| 首轮没有锚定、直接全量工具 | bootstrapTools 中某工具缺失触发 fail-open | 检查目标平台 bash / str_replace_editor 提供者 |
| 简报缺失 | pre-step 注入异常被静默跳过 | 查 host 日志 env-probe 警告；`env_probe` 工具可手动复查 |

---

## 6. 定制入口

- 改人设：`persona` 行 `text`（保持 `complete: true`）。
- 改锚定：`tool-bootstrap` 的 `bootstrapTools` / `promoteOn`（`either` / `tool-call` / `assistant-message`）与 `suppressedContextSources`。
- 改 WSL bash 行为：`wsl-bash` 行的 `config`（`distro`、`username`、`timeoutMs`、`maxOutputBytes`、`probeTimeoutMs`）。
- 加/减能力：增删顶层行；新增服务行必须带 isolate realm，纯消费行保持松散。
- 改显示名：`preset.yml`。
- 派生新预设：复制整个目录为新 id（`[a-z0-9][a-z0-9-]*`），改 `preset.yml` 后重启。
