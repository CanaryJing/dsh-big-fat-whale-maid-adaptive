# DS女仆长模式 · v3.0.0

DSH 的个人工程预设：**系统提示词要求中文思考、全能工具面但常驻核心按需解锁、可靠环境简报、实时请求模型 ID、安全工作目录、PowerShell 7 优先绑定**，保留温柔严谨的蓝发蓝瞳鲸鱼娘女仆长风格。

整个目录是一个 DSH bundle；自定义模块只使用 Node 内置模块及包内导入，不依赖 `dsh-wsl-workspace`。组合本身仍依赖 DSH 官方插件与服务，不是脱离 DSH 的独立运行时。

## v3.0.0 重点：全能 ≠ 全量常驻

v2 的「全量工具首轮开放」是给当年不会用工具搜索的 v4 补课。模型换强之后，这笔账变成只付成本：

- 本机 109 个会话、7255 次 `tool/call` 的实测分布：**8 个工具覆盖 86.5%**，前 25 个覆盖 97.1%；
- 目录里约 110 个工具，**约四成从未被调用过**，却每轮重发 schema。

v3 的做法：

- **常驻核心 29 个**（`tool-gate.mjs` 的 `DEFAULT_RESIDENT_TOOLS`）：shell 三通道、文件读写与图像、搜索、任务/交付、技能、记忆读取、交互与目标、后台作业、子代理协作；
- **其余全部按需解锁**：`dev_tool_search` 支持关键词搜索全量目录与按精确名解锁，解锁从下一次请求起生效；
- **解锁持久可恢复**：解锁名写入 `tool/call` 会话事件，重启/恢复后冷扫描重建；
- **子代理默认不裁剪**（`includeSubagents: false`），避免被派活的子代理缺工具卡死；
- **一键回退**：`mode: full` 回到全量首轮可见，不用卸载插件；
- **安全网**：门控工具缺失或过滤器异常时自动降级全量，绝不锁死会话。

门控裁的是**模型可见 schema**，不是权限：被锁的工具直接调用会得到 `UNKNOWN_TOOL`，解锁后仍走原有审批与沙箱策略。

## v2.3.0 重点：中文思考写进系统提示词

「用中文思考」升级为 persona 前缀里的**第一条显式规则**，不再依赖记忆条目、会话习惯或用户当场提醒：

- 推理、权衡、计划、验证与自我纠错一律用简体中文书写，不得悄悄换成别的语言；
- 代码、命令、文件路径、标识符、被引用的日志与文档正文保持原文语言，不做翻译；
- 对用户可见的回复仍跟随用户语言（用户说中文就用中文）。
- `complete:false` 不变，因此该规则与环境段、模型 ID 段、任务模式叠加句共存。
- 旧格式 `agent.cordis.yml` 的 persona 同步补上同一条，历史备查文件不再与现版自相矛盾。

## v2.2.0 重点

### 环境简报始终可见

`[ENV]` 从首轮 user 消息改为 **每次请求装配的系统 section**：

- 缓存宿主 OS、内核、架构、CPU、内存、用户、home/tmp、可用 shell 候选及路径规则；工作目录按当前会话生成。
- 首次请求等待异步探测完成，不会先发送空环境；重启、恢复、上下文压缩后仍能重新装配，不会碰撞旧 `env-brief-*` 消息 ID。
- `env_probe` 可重新采集缓存并显式冒烟测试，可能启动 WSL；常规请求不反复探测。
- 明确区分“发现可执行文件”“已验证 PowerShell 版本”和“已实际执行冒烟测试”，未发现 WSL 不再声称 bash 可用。
- 修复旧环境消息被误认成 AGENTS 指令提示的问题，旧会话日志仍可识别。

### 当前模型 ID，而不是初始模型

`[MODEL]` 使用 DSH 的 `{{model}}` / `{{provider}}`，在最终 prompt 渲染时读取**当前请求选定的 provider model ID**，跟随官方 UI 切换模型。不会读可能过时的 `agent.options.model`。

这是 DSH 请求路由 ID，**不是对反向代理背后实际模型身份的鉴定**。

为了保留环境段，persona 使用 `complete: false`。旧的 `complete:true` 会让 DSH 丢弃其他系统段，并复原 waterfall 中对 persona 的追加；这一点已用真实 DSH prompt registry 测试。

### PowerShell 7 优先、没有 7 才回退默认

- `gitbash` 仍是全局第一优先。PowerShell 专属操作、`.ps1` 和 Windows UI 自动化使用 `pwsh` 工具。
- 枚举常见安装位置和 PATH，实际校验版本、edition、进程可执行文件路径，**将工具 argv 固定到验证后的绝对路径**，不只依赖提示词或 PATH。
- 优先稳定 PowerShell 7+，同类选择较高版本，再考虑 preview。
- **没有有效的 7 时回退系统默认 PowerShell**（Windows 包括 5.1），简报和工具描述明确显示实际版本、路径及 fallback 状态。
- 绑定后命令执行失败直接报错，不再偷偷换另一个 PowerShell 重试。
- 可选配置 `env-probe.config.pwshPath` 固定一个 PowerShell 7+ 路径。显式固定路径无效时报告不可用，不绕过配置选择其他后端；跨机器通常无需配置此项。

### 工作目录失败关闭

- Git Bash 的目录作为完整 POSIX 单引号参数传给 `cd --`；`$()`、反引号、单双引号、空格和中文保持字面含义。
- `cd` 失败立即退出，不执行后续命令。
- 显式空值、相对路径、NUL、未知世界报错，不再静默回退到系统目录。
- Git Bash 支持 Windows 绝对盘符、WSL/SMB UNC、MSYS 路径；其他 Linux 绝对路径需要默认 WSL 发行版。
- Windows PowerShell 接受 Windows 绝对盘符/UNC；原生 Linux/macOS PowerShell 接受原生绝对目录。

## 安装 / 升级

本版在 **DSH 0.2.0-rc.2** 实测。使用当前支持 bundle、prompt variable 与 section API 的 DSH；不再支持旧 `.agent-presets` 目录安装方式。

```bash
# 从源码目录安装；请替换路径和实际 profile
 dsh plugin --profile web add "file:/absolute/path/to/big-fat-whale-maid-adaptive"

# 或安装 GitHub Release 下载的 tgz
 dsh plugin --profile web add "file:/absolute/path/to/dsh-preset-big-fat-whale-maid-adaptive-3.0.0.tgz"
```

- 使用实际宿主对应的官方插件管理 CLI。Electron 的 `desktop` 档须用桌面版自带 CLI 管理。
- **Tauri profile 使用真实目录来源，不要用 `file:…tgz`。** 已复现 Tauri 启动清理把 tgz 误判为悬空目录并自动卸载；请先解压到持久目录或使用源码目录，再执行 `dsh plugin --profile tauri add "file:/absolute/path/to/preset-directory"`，并保留来源目录。
- 安装完成后重启对应宿主，并选择「DS女仆长模式」。安装文件成功不代表正在运行的旧实例已经热更新。
- `git pull` 后须重新安装；本地 `file:` 依赖通常是安装快照，不保证自动跟随源码。
- 不要直接复制整个 profile 或 `node_modules`；遇供应链/兼容限制应检查原因，不要默默关闭保护。

维护和安装细节见 [AI.md](./AI.md)、[AIreadme.md](./AIreadme.md)。

## 验证

```bash
npm test
# 可选，接入已安装 DSH 的真实 prompt/model-selection 服务
DSH_TEST_ANCHOR=/path/to/dsh npm test
# 可选，只验证这一份本机 PowerShell 7，不执行 WSL 或 5.1
PWSH_RUNTIME_REAL_PATH='C:\Program Files\PowerShell\7\pwsh.exe' npm test
```

测试覆盖首轮异步探测、每轮/重启/压缩环境上下文、切模、字面大括号路径、旧指令提示识别、shell 转义与失败阻断、PowerShell 7 选择及默认后端回退。普通测试对 PowerShell 探测使用 mock；真实 DSH/PowerShell 检查按需启用。Git Bash 可用时另做真实目录攻击字符串验证。

## 能力与边界

- 所有**已注册且可用**工具都在目录里，但首轮只常驻高频核心；其余用 `dev_tool_search` 解锁。能力齐全不代表所有提供者均已安装、认证；技能按需 `skill_search` / `skill_load`。
- 保留原有任务分类、子代理、workflow、goal、计划模式、交付检查工具。本次没有重写任务分类器或 `delivery_check` 校验器。
- `delivery_check` 是检查辅助与模型遵守的交付约定，不是不可绕过的安全门禁。
- shell 路由建议不是 OS 沙箱；真实权限、审批、网络边界由宿主、当前账户和 DSH 底座决定。
- 旧 `agent.cordis.yml`、`preset.yml` 和 bootstrap/gate 源码仅备查，不参与现行组合。改人设、展示名和工具行请编辑 `cordis.patch.yml`。

## 来源与致谢

v3 的按需解锁是自研门控（`tool-gate.mjs`：常驻核心 + `dev_tool_search` + 会话事件持久化），不依赖、也没有恢复首轮锚定与四阶段披露。仍沿用部分通用模块：

- [风神 / dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite)：任务分类、模式提示、交付检查。
- [明神 / dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)：技能按需加载、指令文件提示、epoch 追踪。

完整归属见 [CREDITS.md](./CREDITS.md)。

## 版本历史

- **v3.0.0**：全能工具面改为「常驻核心 + 按需解锁」（`tool-gate.mjs` / `dev_tool_search`），解锁持久化、子代理不裁剪、`mode: full` 可回退；`dev_router_status` 报告真实门控状态。详见 [发行说明](./releases/v3.0.0.md)。
- **v2.3.0**：系统提示词（persona 前缀）要求以中文进行思考，旧备查人设同步；其余行为与 v2.2.0 一致。详见 [发行说明](./releases/v2.3.0.md)。
- **v2.2.0**：可靠系统环境段、实时模型路由 ID、PowerShell 版本验证绑定与默认回退、安全工作目录、精简人设、自包含回归测试。详见 [发行说明](./releases/v2.2.0.md)。
- **v2.1.2**：修复 DSH v4 会话格式不接受裸 `kind: plugin` 的消息来源问题。
- **v2.1.1**：预设内部模块改用包内子路径，修复相对路径导致的装载失败。
- **v2.1.0**：迁移 bundle 格式；存在装载缺陷，应升级后续版本。
- **v2.0.1**：修复 `env_probe` 引用已更名函数的回归。
- **v2.0.0**：全量工具开放，独立环境探测和 Git Bash 优先。
- **v1.x**：历史锚定与渐进披露实现，保留在 Git 历史中。
