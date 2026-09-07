# 大肥鱼女仆长 · 环境自适应模式（改编自风神插件与明神插件）

> DSH（DeepSeek Harness）自定义 Agent Preset 插件：首轮以 Linux 极简双工具「开智」锚定，自动探测宿主环境（原生 Linux / 原生 Windows / WSL 内外）与工作目录所属世界，`gitbash` 默认操作 Windows 母系统（`pwsh` 兜底）、`bash` 直达 WSL 发行版；晋升后进入**任务感知思维模式路由**（react / spec / weak）与**四阶段渐进工具披露**（了解 → 方案 → 开发 → 验证 + `delivery_check` 交付 gate），`dev_tool_search` 按需解锁更重工具；全程保持蓝发蓝瞳鲸鱼娘女仆长人设。
>
> **单预设自包含 · 零外部插件依赖**：不依赖 `dsh-wsl-workspace`，复制一个文件夹即可使用。

---

## 一、这个插件是做什么的？

它是 DSH 的一个 **Agent Preset**（自定义智能体模式），在一个模式里解决了九件事：

| # | 能力 | 说明 |
|---|---|---|
| 1 | 首轮「开智」锚定 | 会话第一轮只暴露 Linux 极简模式的双工具（`bash + str_replace_editor`），统一注入门控（context-gate）屏蔽全部自动注入上下文，让模型以最稳定的轨迹起步 |
| 2 | 判断运行环境 | 自动识别宿主是**原生 Linux**、**原生 Windows**、还是**运行在 WSL 内部**，并枚举 WSL 发行版与默认发行版 |
| 3 | 判断工作目录世界 | 自动判定当前工作目录属于 **Windows 母系统**、**WSL 文件系统**（`\\wsl.localhost\…`）还是**原生 Linux**，并给出路径互转规则 |
| 4 | 三世界 shell 路由 | Windows 宿主上：`gitbash`（Git Bash）**默认**操作 Windows 母系统，`pwsh` 在 Git Bash 不可用或需要 PowerShell 专属能力时兜底；`bash` 工具**直达 WSL 发行版里的 bash**（预设自带的 wsl-bash 实现，通过 `wsl.exe` 调用）；Linux 宿主上全原生 |
| 5 | 思维模式路由 | 晋升后按任务分类自动叠加模式句：**react**（开发/创建 → 动手交付）、**spec**（修复/调试 → 先查后改）、**weak**（模糊任务 → 模型自路由，Flash 模型带回顾/收敛/反跑题三锚） |
| 6 | 渐进式工具披露 | 晋升后四阶段闯关：**了解/对齐 → 拟合方案 → 开发 → 验证**，每阶段只暴露当前档工具（预解锁归零），调用下一档工具自动跳级，阶段状态按会话持久化 |
| 7 | 交付 gate | 验证阶段 `delivery_check` 强制交付契约：文件存在/非空/UTF-8 + 证据清单（页面/图像必须含已复核的视觉证据），PASS 才允许宣告完成 |
| 8 | 按需工具解锁 | `dev_tool_search` 按名解锁更重的 Standard 工具（web_search、subagent、workflow…）；`skill_search` / `skill_load` 按需加载技能，替代 ~9KB 技能目录注入；`instruction-hint` 只提示指令文件存在，模型自己读文件 |
| 9 | 女仆长人设 | 蓝发蓝瞳鲸鱼娘女仆长（DeepSeek 娘）完整人设与外貌设定，中文思考，温柔可靠、专业严谨 |

首轮还会自动注入一条**英文环境简报**（省 token），告诉模型当前宿主、目录世界、三个 shell 分别通往哪里、路径如何互转；晋升后随时可调用 `env_probe` 工具复查环境并实测两侧 shell，`dev_router_status` 查看当前路由状态。

---

## 二、功能特性一览

- ✅ **零外部插件依赖**：全部 `.mjs` 只使用 `node:` 内置模块，用户预设目录下可直接运行。
- ✅ **平台互斥自动分派**：win32 与非 win32 各只有一组 `bash`/`str_replace_editor` 提供者，绝无重复注册。
- ✅ **win32 三 shell 路由**：`gitbash`（Git Bash）默认操作 Windows 母系统文件；`pwsh`（优先 PowerShell 7，兜底 5.1）兜底；`bash` 直达 WSL 发行版。
- ✅ **`wsl-` 变体自禁用**：被 `dsh-wsl-workspace` 生成器复制为 `wsl-*` 变体时自动让位，避免工具冲突。
- ✅ **无机器相关路径**：不含任何绝对路径，装到任何机器都无需改配置。
- ✅ **安全降级**：WSL 缺失、shell 探测失败等场景一律 fail-open，不阻断预设运行。
- ✅ **压缩后回落**：`compaction/end` 后回到受控面（锚定对 + 核心工作集），新晋升信号后恢复。

---

## 三、快速安装（三步）

1. **前置条件**：已安装 DSH CLI 与 `dsh web`。Windows 宿主想用「bash 直达 WSL」功能时，需先安装任意 WSL 发行版（如 `wsl --install -d kali-linux`）。
2. **复制本项目文件夹**到用户预设根目录：
   ```powershell
   Copy-Item -Recurse . "$env:USERPROFILE\.dsh\.agent-presets\big-fat-whale-maid-adaptive"
   ```
3. **重启 `dsh web`**，在模式选择器中选择「大肥鱼女仆长 · 环境自适应模式」。

> 详细安装方法、验证清单与故障诊断见 **[AIreadme.md](./AIreadme.md)**。

---

## 四、项目文件

```
big-fat-whale-maid-adaptive/
├── agent.cordis.yml        # Agent 组合定义（24 行：门控、锚定、路由、渐进披露、环境、人设）
├── preset.yml              # 模式列表里显示的元数据
├── context-gate.mjs        # 统一注入门控（anchored-standard 移植，必须排第一）
├── compaction-epoch.mjs    # epoch 感知晋升追踪（context-gate / tool-bootstrap 共享）
├── tool-bootstrap.mjs       # 首轮双工具锚定 + 压缩后回落（anchored-standard 改造版）
├── router-core.mjs          # 思维模式路由核心（纯函数库，无 apply，不作为插件装载）
├── router-progressive.mjs   # 四阶段渐进披露 + delivery_check + 路由自检工具
├── dev-tool-search.mjs      # 按需工具解锁（dev_tool_search）
├── skill-search.mjs         # 技能搜索（skill_search / skill_load）
├── instruction-hint.mjs     # 指令文件短提示（替代完整 AGENTS.md digest）
├── env-probe.mjs            # 环境探测 + 英文简报注入 + env_probe/gitbash/pwsh 工具
├── wsl-bash.mjs             # 自包含的「bash 直达 WSL」工具（wsl.exe）
├── README.md                # 本文件：插件作用说明（给人看）
├── AI.md                    # 面向 AI 的项目构成与安装说明
├── AIreadme.md              # 安装方法说明（给 AI / 维护者看）
└── CREDITS.md               # 改编来源与致谢（上游插件）
```

---

## 五、常见问题

| 问题 | 原因与处理 |
|---|---|
| Windows 上 bash 工具不存在 | 没装 WSL 发行版或 `wsl.exe -l -q` 列不出任何发行版。安装 WSL 后重启 dsh web；预设会安全降级为全量目录 |
| bash 报「workdir is not in any known world」 | 传入的 workdir 不是 WSL UNC / Linux 路径 / Windows 盘符三者之一 |
| resume 报「tool "bash" is already registered」 | 与其它预设的 wsl-* 自动变体冲突（dsh-wsl-workspace 生成器上游坑）。本预设通过「变体目录自禁用」规避；如遇旧会话，重启 dsh web 后新建会话即可 |
| 晋升后工具很少 | 渐进披露机制：当前阶段只暴露当前档工具。用 `dev_router_status` 查看阶段，`phase_advance` 推进，或调用下一档工具自动跳级；`dev_tool_search` 可按名解锁任意工具 |
| delivery_check 报 FAIL | 交付契约未满足：检查文件存在/非空/UTF-8 与证据清单（页面/图像类必须 `reviewed: true`），修复后重跑 |
| 想自定义 | 复制整个文件夹为新 id，编辑 `agent.cordis.yml`（改人设/加删工具行）与 `preset.yml`（显示名），详见 `AIreadme.md` |

---

## 六、改编来源与致谢

本项目改编自两位 DSH 社区插件作者的优秀作品——**风神**（yjh051108）的 dsh-routing-suite 与**明神**（xiaobright）的 dsh-anchored-standard，感谢他们的设计与公开分享：

| 上游项目 | 作者 | 本项目借鉴 |
|---|---|---|
| [dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite) | **风神**（yjh051108） | 思维模式路由（react/spec/weak 分类 + 模型感知叠加句）、四阶段渐进披露、delivery_check 交付 gate、Git Bash 探测经验 |
| [dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard) | **明神**（xiaobright） | 首轮 Minimal 双工具锚定、统一注入门控（context-gate）、epoch 感知晋升、按需工具解锁（dev_tool_search / skill_search）、指令文件短提示 |

详细改编说明与致谢见 [CREDITS.md](./CREDITS.md)。
