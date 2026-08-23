# 大肥鱼女仆长 · 环境自适应模式(改编自风神插件)

> DSH（DeepSeek Harness）自定义 Agent Preset 插件：首轮以 Linux 极简双工具「开智」锚定，自动探测宿主环境（原生 Linux / 原生 Windows / WSL 内外）与工作目录所属世界，`bash` 直达 WSL 发行版、`pwsh` 操作 Windows 母系统，晋升后开放全量工具，全程保持蓝发蓝瞳鲸鱼娘女仆长人设。
>
> **单预设自包含 · 零外部插件依赖**：不依赖 `dsh-wsl-workspace`，复制一个文件夹即可使用。

---

## 一、这个插件是做什么的？

它是 DSH 的一个 **Agent Preset**（自定义智能体模式），在一个模式里解决了六件事：

| # | 能力 | 说明 |
|---|---|---|
| 1 | 首轮「开智」锚定 | 会话第一轮只暴露 Linux 极简模式的双工具（`bash + str_replace_editor`），并屏蔽自动注入的 AGENTS.md 与技能目录，让模型以最稳定的轨迹起步 |
| 2 | 判断运行环境 | 自动识别宿主是**原生 Linux**、**原生 Windows**、还是**运行在 WSL 内部**，并枚举 WSL 发行版与默认发行版 |
| 3 | 判断工作目录世界 | 自动判定当前工作目录属于 **Windows 母系统**、**WSL 文件系统**（`\\wsl.localhost\…`）还是**原生 Linux**，并给出路径互转规则 |
| 4 | 双世界 shell 路由 | Windows 宿主上：`bash` 工具**直达 WSL 发行版里的 bash**（预设自带的 wsl-bash 实现，通过 `wsl.exe` 调用），`pwsh` 工具操作 Windows 母系统；Linux 宿主上全原生，检测到 pwsh 才注册；WSL 内运行时可通过 PowerShell interop 触达 Windows 母系统 |
| 5 | 全工具晋升 | 首次工具调用/回复后晋升完整工具目录：文件、Shell、Skills、Goals、Plan、Compaction、子代理（含 Codex / Claude Code）、Workflow、Ralph、Web 搜索等 |
| 6 | 女仆长人设 | 蓝发蓝瞳鲸鱼娘女仆长（DeepSeek 娘）完整人设与外貌设定，中文思考，温柔可靠、专业严谨 |

首轮还会自动注入一条**环境简报**，告诉模型当前宿主、目录世界、两个 shell 分别通往哪里、路径如何互转；晋升后随时可调用 `env_probe` 工具复查环境并实测两侧 shell。

---

## 二、功能特性一览

- ✅ **零外部插件依赖**：三个 `.mjs` 只使用 `node:` 内置模块，用户预设目录下可直接运行。
- ✅ **平台互斥自动分派**：win32 与非 win32 各只有一组 `bash`/`str_replace_editor` 提供者，绝无重复注册。
- ✅ **`wsl-` 变体自禁用**：被 `dsh-wsl-workspace` 生成器复制为 `wsl-*` 变体时自动让位，避免工具冲突。
- ✅ **无机器相关路径**：不含任何绝对路径，装到任何机器都无需改配置。
- ✅ **安全降级**：WSL 缺失、shell 探测失败等场景一律 fail-open，不阻断预设运行。

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
├── agent.cordis.yml      # Agent 组合定义（工具、人设、平台分派）
├── preset.yml            # 模式列表里显示的元数据
├── tool-bootstrap.mjs    # 首轮双工具锚定 + 晋升引擎
├── env-probe.mjs         # 环境探测 + 简报注入 + env_probe/pwsh 工具
├── wsl-bash.mjs          # 自包含的「bash 直达 WSL」工具（wsl.exe）
├── readme.md             # 本文件：插件作用说明（给人看）
├── AIreadme.md           # 安装方法说明（给 AI / 维护者看）
└── CREDITS.md            # 改编来源与致谢（上游插件）
```

---

## 五、常见问题

| 问题 | 原因与处理 |
|---|---|
| Windows 上 bash 工具不存在 | 没装 WSL 发行版或 `wsl.exe -l -q` 列不出任何发行版。安装 WSL 后重启 dsh web；预设会安全降级为全量目录 |
| bash 报「workdir is not in any known world」 | 传入的 workdir 不是 WSL UNC / Linux 路径 / Windows 盘符三者之一 |
| resume 报「tool "bash" is already registered」 | 与其它预设的 wsl-* 自动变体冲突（dsh-wsl-workspace 生成器上游坑）。本预设通过「变体目录自禁用」规避；如遇旧会话，重启 dsh web 后新建会话即可 |
| 想自定义 | 复制整个文件夹为新 id，编辑 `agent.cordis.yml`（改人设/加删工具行）与 `preset.yml`（显示名），详见 `AIreadme.md` |

---

## 六、改编来源与致谢

本项目改编自两个 DSH 社区插件（也就是标题中提到的「风神插件」），感谢原作者的优秀设计与公开分享：

| 上游项目 | 作者 | 本项目借鉴 |
|---|---|---|
| [dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard) | xiaobright | 首轮 Minimal 双工具锚定、两阶段晋升、抑制自动注入上下文的「开智」机制 |
| [dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite) | yjh051108 | 工具按宿主 / 目录世界路由的思路、平台分派互斥与 `wsl-` 变体自禁用经验 |

详细改编说明与致谢见 [CREDITS.md](./CREDITS.md)。

