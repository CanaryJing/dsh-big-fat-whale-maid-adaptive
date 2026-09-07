# AI.md — 给 AI 看的项目构成与安装说明

> 本文件面向需要安装、维护、改造或诊断本预设的 AI 智能体。人类说明见 `README.md`。
> 本预设**单目录自包含**：不依赖 dsh-wsl-workspace 插件，不需要修改任何绝对路径。

## 1. 项目构成

```
big-fat-whale-maid-adaptive/
├── agent.cordis.yml      # Agent-plane Cordis 组合（顶层 20 行）
├── preset.yml            # 展示元数据：name / description / order
├── tool-bootstrap.mjs    # 锚定引导插件（anchored-standard 实现）
├── env-probe.mjs         # 环境探测插件（原创核心）
└── wsl-bash.mjs          # 自包含「bash 直达 WSL」工具插件（原创）
```

### 1.1 `agent.cordis.yml` 顶层行（按注册顺序）

| id | 类型 | 作用 |
|---|---|---|
| `tool-bootstrap` | `./tool-bootstrap.mjs` | 必须排第一。首轮只暴露 `bash + str_replace_editor`，抑制 `agent-instructions` 与 `skill-catalog` 注入；`promoteOn: either`；bootstrap 工具缺失时 fail-open 到全量目录 |
| `env-probe` | `./env-probe.mjs` | 挂载时探测静态环境；每会话首轮注入环境简报（source kind `env-probe`，不会被 bootstrap 过滤）；注册 `env_probe` 工具；非 win32 且探测到 pwsh/powershell.exe 时注册 `pwsh` 工具 |
| `persona` | `@deepseek-ai/dsh-persona` | 女仆长人设 + 外貌设定；`complete: true`、`includeRuntimeContext: false` |
| `agent-instructions` | `@deepseek-ai/dsh-agent-instructions` | 晋升后注入 AGENTS.md 摘要 |
| `native-persistent-shell` | cordis:group，isolate `terminals` | 非 win32 提供 Minimal 同款持久 PTY bash（工具名 `bash`）；`disabled: win32` |
| `wsl-bash` | `./wsl-bash.mjs` | 仅 win32 启用；`disabled: !!js process.platform !== 'win32' \|\| /[\\/]wsl-/.test(baseUrl)`（`wsl-` 自禁用让位给自动变体的 bash） |
| `str-replace-editor` | 官方行（host fs） | 仅 win32 启用 + `wsl-` 自禁用；win32 上用宿主文件系统（Windows 路径与 `\\wsl.localhost\<distro>\…` 均可） |
| `bootstrap-filesystem` | cordis:group，isolate `fs` | 非 win32 提供 Minimal 同款 fs-local + str_replace_editor；`disabled: win32` |
| `tool-fs` | 官方行 | 全平台注册，走宿主文件系统（win32 上 WSL 文件经 UNC 访问） |
| `tool-fs-search` | 官方行 | 仅非 win32；win32 上故意不注册（Windows ripgrep 读不了 WSL 路径），WSL 侧用 bash find/grep |
| `tool-jobs` / `skill-filesystem` / `tool-skill` / `tool-goal` | 官方行 | 宿主平面服务的模型面消费行，不放 realm |
| `planning` | cordis:group，isolate `planMode` | 计划模式 |
| `compaction` | cordis:group，isolate `compaction`+`toolResultPruner` | 压缩 + 工具结果裁剪 |
| `delegation` | cordis:group，isolate `workflowEngine` | subagent / subagent_fork / codex / claude-code（已启用）/ workflow / ralph |
| `tool-ask-user` / `tool-todo` / `tool-web` | 官方行 | 提问、待办、Web 搜索 |

### 1.2 关键设计约束（改造时不得破坏）

1. **bootstrapTools 必须正好是 `[bash, str_replace_editor]`**，且两个名字在目标平台必须有注册者：
   - win32：`bash` 由 `wsl-bash` 行提供，`str_replace_editor` 由顶层 editor 行提供；
   - 非 win32：`bash` 由 `native-persistent-shell` 提供，`str_replace_editor` 由 `bootstrap-filesystem` 提供。
2. **平台分派互斥**：两组 bash/editor 提供者绝不可同时启用，否则报 `tool "bash" is already registered in this scope`。
3. **`wsl-` 变体自禁用**：`wsl-bash` 与顶层 `str-replace-editor` 的 disabled 表达式必须包含 `/[\\/]wsl-/.test(baseUrl)`——当本目录被复制成 `wsl-*` 变体时（dsh-wsl-workspace 的生成器会为每个源预设生成变体并把 bash/editor 替换为它自己的 WSL 实现），这两行必须自动让位，否则变体双注册冲突。
4. **服务行必须带 isolate realm**：`native-persistent-shell`（terminals）、`bootstrap-filesystem`（fs）；纯消费官方行不放 realm。
5. **本地 mjs 零外部依赖**：用户 home 下的 preset 无法解析 harness 的 `@deepseek-ai/*` 包，三个 `.mjs` 只允许 `node:` 内置模块 import。
6. **无任何机器相关路径**：本预设没有绝对路径行；安装到任何机器都无需改配置。

### 1.3 `wsl-bash.mjs` 接口

- `export const name / inject = ['tools','subprocess'] / apply(ctx, config)`
- 导出测试函数 `planFor(workdir, fallbackDistro, username)`：三态翻译
  - `\\wsl.localhost\<distro>\…`（或 `\\wsl$\…`）→ 取 distro 与 Linux 路径；
  - `/…` Linux 路径 → fallbackDistro，`windowsCwd` 回退 `SystemRoot`（进程 cwd 可能是 UNC）；
  - `C:\…` → `/mnt/<drive>/…`，`windowsCwd` 用原 Windows 路径。
- 执行形状：`wsl.exe -d <distro> [--cd <linuxCwd>] -e bash -lc <command>`；每次独立进程；输出有界；非零退出抛错；env 注入 `NO_COLOR/TERM/PAGER/GIT_PAGER`。
- 挂载时解析默认发行版：`config.distro` > Lxss 注册表默认 > `wsl.exe -l -q` 第一项；全部失败则**不注册 bash**（bootstrap 会 fail-open 到全量目录），绝不抛错。

### 1.4 `env-probe.mjs` 接口

- 导出测试函数：`probeStatic(timeoutMs)`、`worldOf(cwd)`、`buildBrief(snapshot, cwd)`
- `probeStatic`：platform + insideWsl（/proc/version + WSL_DISTRO_NAME）+ `wsl.exe -l -q` + Lxss 注册表默认发行版（Windows）；Linux 上探测 pwsh / WSL 内 powershell.exe interop / wine。失败一律降级。
- `worldOf`：UNC → wsl 世界（含 distro/linuxPath）；`/…` → linux；`X:\…` → windows（附 `/mnt/x/…` 换算）。
- pre-step 每会话注入一次简报（`source.kind = 'env-probe'`，Set 去重，异常静默跳过）。
- `env_probe` 工具：无参数但必须 object-rooted JSON Schema（**勿改回 `{}`**），执行时重新探测 + 冒烟测试 bash/pwsh。
- `pwsh` 工具：仅非 win32 且后端可用时注册；WSL 内优先 Linux 原生 pwsh，其次 `powershell.exe` interop。

## 2. 安装方法（AI 执行手册）

1. **校验环境**：Windows 宿主需 `wsl.exe -l -q` 至少列出一个发行版（否则 bash 工具不注册，预设仍可运行但降级全量目录）；Linux 宿主无额外要求。
2. **复制项目**：
   ```powershell
   $dst = "$env:USERPROFILE\.dsh\.agent-presets\big-fat-whale-maid-adaptive"
   New-Item -ItemType Directory -Force -Path $dst | Out-Null
   Copy-Item agent.cordis.yml,preset.yml,tool-bootstrap.mjs,env-probe.mjs,wsl-bash.mjs $dst -Force
   ```
   无需任何路径修改（自包含）。
3. **验证清单（发布前）**：
   - `node --check` 三个 mjs；
   - 顶层 `- id:` 无重复；`name:` 行无绝对路径、无 dsh-wsl-workspace；
   - `bootstrapTools` 为 `[bash, str_replace_editor]`；
   - 平台分派与 `wsl-` 自禁用条件正确（见 1.2 第 2、3 条）；
   - mock ctx `apply()`：注册工具 parameters 均为 object-rooted JSON Schema；
   - `planFor` 三态翻译正确；真实运行 `wsl.exe -d <distro> --cd /home/<user> -e bash -lc 'echo ok; uname -srm'` 成功；
   - 模拟 dsh-wsl-workspace 变体生成器（WORLD_ROWS = tool-bash/tool-pwsh/tool-fs/tool-fs-search/filesystem/persistent-shell）：win32 视角变体的活跃 bash/editor 提供者都恰好 1。
4. **生效**：重启 `dsh web`；新建会话选择该预设；首轮应只见 `bash + str_replace_editor` + 环境简报。

## 3. 常见故障诊断

| 症状 | 根因 | 修复 |
|---|---|---|
| `Invalid schema ... got 'type: null'` | 工具 `parameters` 是空对象 `{}` | 用 `toJsonSchema({})` 或显式 object-rooted JSON Schema |
| `tool "bash" is already registered in this scope` | 同层两个 bash 提供者（win32 上 wsl-bash 与持久 shell 同时启用，或 `wsl-*` 变体未让位） | 检查平台 disabled 互斥与 `/[\\/]wsl-/.test(baseUrl)` 自禁用 |
| 挂载报缺失 `./wsl-bash.mjs` | 文件未复制 | 确认 5 个文件齐全 |
| Windows 上 bash 调用失败 `terminal inspection is unsupported` | 模型拿到的是 PTY 持久 bash（native-persistent-shell 未被 win32 禁用） | 复核 disabled 表达式 |
| bash 报 `workdir is not in any known world` | workdir 不是 UNC / Linux / 盘符三者之一 | 传入合法路径或让模型传绝对路径 |
| 首轮没有锚定、直接全量工具 | bootstrapTools 中某工具缺失触发 fail-open | 检查目标平台 bash / str_replace_editor 提供者 |
| 简报缺失 | pre-step 注入异常被静默跳过 | 查 host 日志 env-probe 警告；`env_probe` 工具可手动复查 |

## 4. 定制入口

- 改人设：`persona` 行 `text`（保持 `complete: true`）。
- 改锚定：`tool-bootstrap` 的 `bootstrapTools` / `promoteOn`（`either` / `tool-call` / `assistant-message`）与 `suppressedContextSources`。
- 改 WSL bash 行为：`wsl-bash` 行的 `config`（`distro`、`username`、`timeoutMs`、`maxOutputBytes`、`probeTimeoutMs`）。
- 加/减能力：增删顶层行；新增服务行必须带 isolate realm，纯消费行保持松散。
- 改显示名：`preset.yml`。
- 派生新预设：复制整个目录为新 id（`[a-z0-9][a-z0-9-]*`），改 `preset.yml` 后重启。
