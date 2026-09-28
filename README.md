# DS女仆长模式

> **当前版本 v2.0 · 独立实现**：已移除并**不再采用**风神（dsh-routing-suite）与明神（dsh-anchored-standard）的上游方案（首轮锚定 / 注入门控 / 渐进披露 / 按需解锁）。
>
> DSH（DeepSeek Harness）自定义 Agent Preset 插件：**全量工具一次性开放**——所有已注册工具从第一轮起全部可见（无首轮锚定、无四阶段渐进披露、无按需解锁）；自动探测宿主系统（Windows / Linux / WSL / macOS / Android）与工作目录所属世界，`gitbash` **全环境第一优先**（Windows 母系统、WSL 文件经 UNC、通用 shell 任务；`pwsh` 兜底）、`bash` 直达 WSL 发行版；任务感知思维模式路由（react / spec / weak）与 `delivery_check` 交付 gate；全程保持蓝发蓝瞳鲸鱼娘女仆长人设。
>
> **单预设自包含 · 零外部插件依赖**：不依赖 `dsh-wsl-workspace`，整个文件夹本身就是一个可安装的 DSH bundle（`package.json` + `cordis.patch.yml` + 本地 `.mjs` 插件），装上即用。

---

## 一、这个插件是做什么的？

它是 DSH 的一个 **Agent Preset**（自定义智能体模式），在一个模式里解决了七件事：

| # | 能力 | 说明 |
|---|---|---|
| 1 | 全量工具开放 | 所有已注册工具从第一轮起全部可见：无首轮锚定、无渐进披露、无按需解锁（2026-09 起按主人要求调整） |
| 2 | 判断运行系统 | 自动识别宿主系统：**Windows / Linux（含 WSL 内外）/ macOS / Android**（未知平台回退 `uname`），并枚举 WSL 发行版与默认发行版 |
| 3 | 判断工作目录世界 | 自动判定当前工作目录属于 **Windows 母系统**、**WSL 文件系统**（`\\wsl.localhost\…`）还是**原生 Linux**，并给出路径互转规则 |
| 4 | gitbash 优先的 shell 路由 | 无论 Windows 母系统文件、WSL 文件（经 `\\wsl.localhost\…` UNC）还是通用 shell 任务，都**优先调用 `gitbash`**；`pwsh` 仅在 Git Bash 不可用或需要 PowerShell 专属能力时兜底；`bash` 工具**直达 WSL 发行版里的 bash**（预设自带的 wsl-bash 实现，通过 `wsl.exe` 调用），仅用于 Linux 侧专属工作或 gitbash 不可用时；macOS / Android 等原生宿主直接用各自 shell |
| 5 | 思维模式路由 | 按任务分类自动叠加模式句：**react**（开发/创建 → 动手交付）、**spec**（修复/调试 → 先查后改）、**weak**（模糊任务 → 模型自路由，Flash 模型带回顾/收敛/反跑题三锚） |
| 6 | 交付 gate | `delivery_check` 强制交付契约：文件存在/非空/UTF-8 + 证据清单（页面/图像必须含已复核的视觉证据），PASS 才允许宣告完成 |
| 7 | 女仆长人设 | 蓝发蓝瞳鲸鱼娘女仆长（DeepSeek 娘）完整人设与外貌设定，中文思考，温柔可靠、专业严谨 |

每会话首轮自动注入一条**英文系统环境报告**（省 token）：宿主系统（OS / 内核 / 架构）、硬件概要（CPU / 线程 / 内存）、用户与 home/tmp、工作目录所属世界、可用 shell 与路径互转规则——覆盖 **Windows / Linux（含 WSL）/ macOS / Android**，让模型一上来就摸清环境；随时可调用 `env_probe` 复查并实测各 shell，`dev_router_status` 查看当前路由状态。技能仍按需加载：`skill_search` / `skill_load` 替代 ~9KB 技能目录注入；`instruction-hint` 只提示指令文件存在，模型自己读文件。

---

## 二、功能特性一览

- ✅ **零外部插件依赖**：全部 `.mjs` 只使用 `node:` 内置模块，用户预设目录下可直接运行。
- ✅ **平台互斥自动分派**：win32 与非 win32 各只有一组 `bash`/`str_replace_editor` 提供者，绝无重复注册。
- ✅ **gitbash 全环境优先**：`gitbash`（Git Bash）为第一优先 shell——Windows 母系统文件、WSL 文件（`//wsl.localhost/…` UNC）与通用 shell/脚本任务；`pwsh`（优先 PowerShell 7，兜底 5.1）与 `bash`（WSL）为回退。
- ✅ **系统环境报告**：首轮简报报告真实系统环境（OS / 内核 / 架构、CPU / 内存、用户与 home/tmp、cwd 世界、shell 与路径规则），覆盖 Windows / Linux（含 WSL）/ macOS / Android，而非仅工具指引。
- ✅ **`wsl-` 变体自禁用**：被 `dsh-wsl-workspace` 生成器复制为 `wsl-*` 变体时自动让位，避免工具冲突。
- ✅ **无机器相关路径**：不含任何绝对路径，装到任何机器都无需改配置。
- ✅ **安全降级**：WSL 缺失、shell 探测失败等场景一律 fail-open，不阻断预设运行。

---

## 三、快速安装（DSH ≥ 0.1.6）

> **⚠️ 安装方式已随 DSH 变更**：DSH 0.1.6 起 agent preset 改为**bundle 声明**，旧格式的
> `$DSH_HOME/.agent-presets/<id>/` 目录**已不再被读取**（官方说明原话：*"Nothing reads that
> directory any more."*）。本仓库因此自带 bundle 声明（`package.json` + `cordis.patch.yml`），
> **整个文件夹就是一个可直接安装的 bundle**，仍然自包含。本地插件模块以**包内子路径**引用
> （`dsh-preset-big-fat-whale-maid-adaptive/<file>.mjs`，由 `package.json` 的 `exports` 放行），
> 而不是相对路径——预设声明内部的解析基准是 **profile 目录**，相对路径会全部解析失败。

1. **前置条件**：已安装 DSH CLI 与 `dsh web`（0.1.6 及以上）。Windows 宿主想用「bash 直达 WSL」功能时，需先安装任意 WSL 发行版（如 `wsl --install -d kali-linux`）。
2. **把本文件夹作为 bundle 加进 profile**（`dsh plugin` 转发给 pnpm，并在成功后自动把本包追加进 `dsh.profile.bundles`）：
   ```powershell
   dsh plugin --profile web add "file:<本文件夹的绝对路径>"
   ```
   若 pnpm 被 `minimumReleaseAge` 一类供应链策略拦下（报 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`，与预设本身无关），可改为手工登记：把本文件夹联进 `profiles/web/node_modules/`，再把包名 `dsh-preset-big-fat-whale-maid-adaptive` 追加进 `profiles/web/package.json` 的 `dsh.profile.bundles`。
3. **重启 `dsh web`**（或依赖 HMR 热加载），在**新建会话**的模式选择器中选择「DS女仆长模式」。

> **升级**：`git pull` 之后需**重新执行一次第 2 步**——bundle 是安装时的快照，不会跟随工作区改动。
> **离线校验**（可选，工作区配套脚本）：`node 脚本/verify-dsh-preset-bundle.mjs <本文件夹>`，会逐行对照已装 DSH 的真实 schema 校验每个插件行的 config。
>
> 详细安装方法、验证清单与故障诊断见 **[AIreadme.md](./AIreadme.md)**。

---

## 四、项目文件

```
big-fat-whale-maid-adaptive/
├── package.json            # bundle 声明：dsh.bundle.patch → ./cordis.patch.yml（整个文件夹即可安装）
├── cordis.patch.yml        # 【现行·权威】agent preset 声明 + 全部插件行（本地模块按包内子路径引用）
├── agent.cordis.yml        # 【旧格式·备查】0.1.5/0.1.6 的 Agent 组合定义（已被 cordis.patch.yml 取代）
├── preset.yml              # 【旧格式·备查】旧模式元数据（name/description/order 已并入 cordis.patch.yml）
├── router-core.mjs         # 思维模式路由核心（纯函数库，无 apply，不作为插件装载）
├── router-progressive.mjs  # 任务模式路由 + delivery_check + dev_router_status（不再做渐进披露）
├── compaction-epoch.mjs    # epoch 感知晋升追踪（instruction-hint 使用）
├── skill-search.mjs        # 技能搜索（skill_search / skill_load）
├── instruction-hint.mjs    # 指令文件短提示（替代完整 AGENTS.md digest）
├── env-probe.mjs           # 环境探测 + 英文简报注入 + env_probe/gitbash/pwsh 工具
├── wsl-bash.mjs            # 自包含的「bash 直达 WSL」工具（wsl.exe）
├── context-gate.mjs        # [已卸载·备查] 旧首轮注入门控（不再参与组合）
├── tool-bootstrap.mjs      # [已卸载·备查] 旧首轮锚定（不再参与组合）
├── dev-tool-search.mjs     # [已卸载·备查] 旧按需解锁（不再参与组合）
├── README.md               # 本文件：插件作用说明（给人看）
├── AI.md                   # 面向 AI 的项目构成与安装说明
├── AIreadme.md             # 安装方法说明（给 AI / 维护者看）
└── CREDITS.md              # 改编来源与致谢（上游插件）
```

---

## 五、常见问题

| 问题 | 原因与处理 |
|---|---|
| Windows 上 bash 工具不存在 | 没装 WSL 发行版或 `wsl.exe -l -q` 列不出任何发行版。安装 WSL 后重启 dsh web；预设会安全降级 |
| bash 报「workdir is not in any known world」 | 传入的 workdir 不是 WSL UNC / Linux 路径 / Windows 盘符三者之一 |
| resume 报「tool "bash" is already registered」 | 与其它预设的 wsl-* 自动变体冲突（dsh-wsl-workspace 生成器上游坑）。本预设通过「变体目录自禁用」规避；如遇旧会话，重启 dsh web 后新建会话即可 |
| 工具不全 | 本预设不做任何工具门控：所有已注册工具从第一轮起全部可见。若仍缺工具，检查该工具是否在组合中注册（agent.cordis.yml）或其平台 `disabled` 条件 |
| 支持哪些系统 | 系统环境报告覆盖 Windows / Linux（含 WSL）/ macOS / Android，未知平台回退 `uname`；shell 与文件工具按平台自动分派 |
| delivery_check 报 FAIL | 交付契约未满足：检查文件存在/非空/UTF-8 与证据清单（页面/图像类必须 `reviewed: true`），修复后重跑 |
| 想自定义 | 复制整个文件夹为新 id，编辑 `agent.cordis.yml`（改人设/加删工具行）与 `preset.yml`（显示名），详见 `AIreadme.md` |

---

## 六、来源说明与致谢

**自 v2.0 起，本预设不再采用风神（dsh-routing-suite）与明神（dsh-anchored-standard）的上游方案**——首轮锚定、统一注入门控、四阶段渐进披露、按需工具解锁均已移除，预设转为独立实现与维护。

仍沿用其少量通用工具模块（归属与致谢保留）：

| 上游项目 | 作者 | 仍沿用的模块 |
|---|---|---|
| [dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite) | **风神**（yjh051108） | `router-core.mjs` 思维模式路由（react/spec/weak 分类 + 模型感知叠加句）、`delivery_check` 交付 gate |
| [dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard) | **明神**（xiaobright） | `skill-search.mjs`（skill_search / skill_load）、`instruction-hint.mjs`（指令文件短提示）、`compaction-epoch.mjs`（epoch 感知追踪） |

> 已移除的上游方案源码保留在仓库备查（`context-gate.mjs` / `tool-bootstrap.mjs` / `dev-tool-search.mjs`），不再装载；历史版本见 git。

详细来源说明见 [CREDITS.md](./CREDITS.md)。

---

## 七、版本历史

- **v2.1.2**（2026-09）：**修 DSH 0.1.7 会话格式 v4 的致命不兼容——消息来源改用 producer-owned kind**。0.1.7-rc.2 起 `@deepseek-ai/dsh-session-format-v3-to-v4` 的校验器 `source()` 对 `{ kind: 'plugin', plugin: <id> }` 这种 v3 写法直接抛 `format v4 message requires a producer-owned source kind`（v4 已退役裸 `plugin` 这个 kind，插件必须盖自己的 `plugin:<id>`）。本预设有两处仍在写旧写法：① `env-probe.mjs` 的「首轮环境简报」——它注册在 `agent/pre-step`，**每轮开始都会注入**，所以症状是**每一轮对话都运行失败**；② `instruction-hint.mjs` 的指令提示（同样挂在 `agent/pre-step`）。现两处均改为自己的 producer kind `plugin:big-fat-whale-maid-adaptive`——这正是 DSH 自带的 v3→v4 迁移函数对未登记插件推导出的形式，所以新旧两代日志读回来是同一个形状。`instruction-hint.mjs` 的「每会话仅一次」耐久判据同步改为同时识别新旧两种 kind（含迁移前的裸 `plugin` + id 形态），否则宿主重启后会重复注入一次提示。
- **v2.1.1**（2026-09）：**修 v2.1.0 的致命装载缺陷——改用包内子路径引用本地插件**。v2.1.0 把预设内部的插件行写成相对路径（`./env-probe.mjs?v=2`），以为它锚定在 patch 文件旁；实测（探针取证）**预设声明内部的行拿到的解析基准是 profile 目录，不是 bundle 目录**，于是 5 个本地插件全部 import 失败，而 `cordis-plugin-loader` 的 `_init()` 对导入失败**只记日志、不抛错**（`entry.fiber` 保持 undefined），挂载审计遂把每一行报成 `never started`，整个预设显示为**加载失败**。现改为 `dsh-preset-big-fat-whale-maid-adaptive/<file>.mjs` 包内子路径（由 `package.json` 的 `exports` 放行），该写法以 profile 目录为基准解析，正是 bundle 的安装位置；同时去掉 `?v=N` 缓存查询串（查询串会破坏 `exports` 子路径匹配）。已在 Windows 与 Android 两端用「模块自报家门」探针实证：修复后挂载内各行的 `apply` 全部执行。
- **v2.1.0**（2026-09）：**迁移到 DSH bundle 声明格式**（⚠️ **此版装载失败，请用 v2.1.1**，原因见上）。DSH 0.1.6/0.1.7 起 agent preset 由 bundle patch 里的 `@deepseek-ai/dsh-agent-preset` 声明行定义，旧的 `$DSH_HOME/.agent-presets/<id>/` 目录不再被读取——本仓库新增 `package.json`（`dsh.bundle.patch`）与 `cordis.patch.yml`（preset 声明 + 插件行），文件夹本身成为可安装 bundle；`preset.yml` / `agent.cordis.yml` 退为旧格式备查。同时按 0.1.7 的实际 schema 对齐插件行：workflow 引擎行由已移除的 `@deepseek-ai/dsh-workflow-worker-thread` 换为 `@deepseek-ai/dsh-workflow-ptc`（`provider: spawn`），补上 0.1.6+ 新增的 `present`（`@deepseek-ai/dsh-tool-present`）与 `command-goal`；修复 `instruction-hint` 的「每会话仅一次」持久化判据与它自己写入的消息来源（`kind: plugin` + 插件 id）不一致、导致宿主重启后重复注入一次提示的问题。
- **v2.0.1**（2026-09）：修复 `env_probe` 工具回归——v2.0.0 把 `shellRoutes` 更名为 `shellSummary` 时，漏改了 `env_probe` 工具内唯一的调用点（该行本身即为从未被使用的死代码，故长期未被发现），导致「重新探测环境」必抛 `ReferenceError: shellRoutes is not defined`，环境报告无法手动刷新；现已删除该死代码行，`env_probe` 恢复可用。
- **v2.0.0**（2026-09）：全量工具一次性开放（移除首轮锚定 / 注入门控 / 四阶段渐进披露 / 按需解锁）；系统环境报告覆盖 Windows / Linux / WSL / macOS / Android；`gitbash` 全环境第一优先（含 WSL UNC 工作目录）；更名「DS女仆长模式」；不再采用风神 / 明神的上游方案。
- **v1.x**：首轮 Linux 极简双工具锚定 + 四阶段渐进披露 + 环境 / 世界路由（改编自风神 / 明神上游）。
