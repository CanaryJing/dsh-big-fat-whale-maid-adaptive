# 安装与验收手册

项目维护约束见 [AI.md](./AI.md)，功能说明见 [README.md](./README.md)。

## 1. 安装对象

当前权威文件是 `package.json` + `cordis.patch.yml`。整个包必须一起安装，本地插件通过包内子路径解析。不要挑选几个 `.mjs` 复制到旧 `.agent-presets` 目录，不要改旧 `agent.cordis.yml` / `preset.yml` 来配置现版。

DSH 官方插件、工具服务、模型提供者由宿主提供。本版在 DSH 0.2.0-rc.2 验证。Windows 的 Git Bash 和 PowerShell 均在母系统执行；WSL Bash 为独立的 Linux 执行世界。没有 WSL 不影响其他工具。

## 2. 备份与安装

先备份**目标 profile** 的 `package.json`、`cordis.patch.yml`、lockfile 和必要的包管理配置；不要读取/传播凭据。保留原有 bundles 和插件，仅更新本预设。

```bash
# 全局 web 实例
 dsh plugin --profile web add "file:/absolute/path/to/package-or-release.tgz"
```

Electron `desktop` 使用桌面安装目录下的官方 CLI，例如 Windows：

```text
<DeepSeek Harness 安装目录>\resources\runtime\cli\bin\dsh.cmd plugin --profile desktop add "file:D:/path/to/package.tgz"
```

不要用普通 CLI boot 保留的 `desktop` 档，不要直接复制 `node_modules`（其中可能记录其他 profile 的绝对 store 路径）。

**Tauri 特例：只用真实目录来源，不使用 `file:…tgz`。** Tauri 的启动清理通过 `is_dir()` 判断 `file:` / `link:` 来源，会把本地 tgz 当作悬空依赖并自动卸载。请先解压到持久目录或使用源码目录，再运行 `dsh plugin --profile tauri add "file:/absolute/path/to/preset-directory"`。不要关闭宿主清理机制；来源目录必须保留。安装后重启一次，确认预设仍在且新建会话成功。

包管理失败时先读日志定位供应链/兼容/依赖问题，不要直接修改引擎或清空整个 profile。源码升级需要重新安装，已有进程不保证热更新。未经允许不要为安装强行重启当前会话。

## 3. PowerShell 配置

默认无需配置：先验证 PowerShell 7+，没有可用 7 时使用系统默认 PowerShell，均绑定实际绝对路径并显示版本。仅在初次探测时选择 fallback，命令执行失败不触发降级重试。

可选的显式固定路径配置位于本预设的 `env-probe` 插件行：

```yaml
config:
  probeTimeoutMs: 10000
  pwshPath: 'C:\Program Files\PowerShell\7\pwsh.exe'
```

这是**当前机器专用配置**，默认发行包不写死该路径。显式固定路径要求 Core 7+；无效时报告不可用，不绕过固定选择。改配置后重载/重启对应宿主。

## 4. 安装验证

1. 版本为 3.1.0；`dsh.profile.bundles` 中预设仅登记一次；原有插件不减少。
2. `package.json` 的 `exports` 指向的文件齐全，新增 helper 被安装：`tool-gate.mjs`、`delivery-check.mjs`、`shell-policy.mjs`、`environment-context.mjs`、`powershell-runtime.mjs`、`shell-workdir.mjs`。
3. 组合 schema 校验通过；`persona.complete:false`，`includeRuntimeContext:false`；平台互斥与 `wsl-` 自禁用仍保留。
4. persona 前缀含 `Reasoning language: think in Chinese` 一条（v2.3.0 起的中文思考规则），且未因此把 `complete` 改成 `true`；persona 只引用 `shell-policy.mjs` 的 section，不再内嵌路由表。
5. 在真实 prompt registry 中看到 `[ENV]` 与 `[MODEL]`；切换模型后下一请求使用新路由 ID，不采用旧 `agent.options`；靠后的 `whale-maid:shell-routing` section 存在且 order 10300，真实组装后位于 `WEB_SURFACE`(10100) 与 `DEPLOYMENT_PERSONA_SUFFIX`(10200) 之后，但不改写权限规则。
6. 直接通过所注册 `pwsh` 工具验证：实际 `$PSVersionTable.PSVersion`、进程路径、中文输出与 cwd。简报版本应与工具一致。
7. 非法工作目录在 spawn 之前拒绝；不存在的目录导致 spawn/cd 报错，不能输出后续命令的成功标志。
8. 门控生效（v3.0.0 起，v3.1.0 扩展）：新会话首轮只看到常驻核心 + `dev_tool_search`；`query` 搜索、`toolNames` 精确名或 `groups` 组解锁后**下一次请求**可见；组只展开当前目录且不越 scope。解锁恢复只接受与本会话 `dev_tool_search` callId 配对成功的 result；其它工具文本/meta、伪造 gate 名、没有 result 的中断调用保持锁定。没有 `agent.session` 时执行返回 `accepted: []`。`dev_router_status` 的 `toolCatalog=progressive (...)` 与之一致。临时回退可把 `tool-gate` 的 `mode` 改成 `full`。
9. 路由生效：最近一条真实用户请求决定模式；插件/自动通知/记忆包装不计，多段 `Current runtime context` 整块剥离；明确问句（如何/为什么/how/what）进入 consult，即使含 fix/build；「只做这个错误的修复」「修复这个错误，不要改其他文件」仍是 spec；`继续/好的/可以` 沿用上一实质任务；「解释/评审/只读/先给计划」进入 consult，「实现/修复」仍进入 react/spec；无可靠意图显示 weak。
10. `delivery_check` 行为已收紧：相对路径只按原生绝对会话 cwd 解析；普通可读非空文件；文本严格 UTF-8；图片/PDF/ZIP 基础格式检查与 central directory 边界；证据 item 必须有 kind/label/result 与本地 target（file/page/image/run/test）；page/image 需人工 `reviewed:true` 且 target 必须是签名有效的图片；图片/PDF/docx/pptx 页面交付至少要一项这样的视觉证据，xlsx 只需数据/测试证据。PASS 只代表基础检查。
11. 当前会话未重启时明确说明“磁盘已更新，运行中实例需重启生效”，不要冒称已经热更新。

## 5. 回归测试

```bash
npm test
DSH_TEST_ANCHOR='C:/Users/admin/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh' npm test
DSH_TEST_ANCHOR='C:/Users/admin/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh' \
PWSH_RUNTIME_REAL_PATH='C:/Program Files/PowerShell/7/pwsh.exe' npm test
```

当前 Windows 工作树在同时设置两个变量后：**122 tests / 122 pass / 0 fail / 0 skip**（2026-10-22 实测）。未设置 anchor/真实 pwsh 路径时，相关集成用例显式 skip，不能计入通过数。

常规 PowerShell 选择/默认回退测试完全 mock，不要求卸载本机 PowerShell 7 或真的运行 5.1。真实绑定检查仅执行指定的 PowerShell 7 路径。Git Bash 真实转义测试创建临时目录并自行清理，不运行攻击命令或 WSL。真实 DSH 集成使用已安装引擎的 `SystemPrompt` / `ToolRuntime`，验证 delivery schema、gate `presentationMeta` 持久化形状、callId 配对恢复与 shell section 真实顺序；不改 `node_modules`。

## 6. 故障定位

| 症状 | 定位与处理 |
|---|---|
| 有人设但没有环境段 | 检查是否误改成 `complete:true`，以及实际装载的预设版本 |
| 切模后 ID 仍旧 | 检查模板与官方 model-selection 耦合，勿读取 agent 初始选项 |
| `pwsh` 版本错误 | 检查简报的绑定路径、版本、fallback 状态与可选 `pwshPath`；不要换成另一个 shell 调用 5.1 |
| 环境探测失败 | 查看简报 warning；`env_probe` 可刷新缓存，失败不能阻断整个会话 |
| 工作目录报错 | 传入当前后端支持的绝对路径，勿改成系统目录后继续任务 |
| 预设 never started / 加载失败 | 检查包已安装、exports 完整、本地插件不是 profile 相对路径 |
| 已安装但行为没变 | 确认实际使用的 profile；对应宿主可能仍在运行旧模块 |
| 工具列表少了（v3） | 属正常门控：用 `dev_tool_search` 搜索/解锁；确认 `tool-gate` 行已装载且 `mode` 不是 `full`……若本该全量却仍被裁，检查 `mode` 配置 |
| 解锁了但仍不可见 | 解锁从**下一次请求**生效；同一轮内不会补进当前请求。恢复会话后仍不可见则检查成功 `tool/result` 的 `meta.accepted` 是否与 `dev_tool_search` 的 callId 配对；仅 call 无 result（中断）的旧日志需要重新解锁；失败/其它工具的伪造结果不会恢复 |
| delivery_check 误报 PASS/FAIL | 先看 `scope` 与具体 check。相对路径必须有原生绝对会话 cwd；文本超限会 FAIL；未知扩展名会做可读性检查；page/image 的 reviewed 只是人工声明，且 target 必须是签名有效的图片；图片/PDF/docx/pptx 页面交付没有视觉证据会 FAIL；xlsx 不要求视觉证据 |
| shell 选择被泛化提示干扰 | 找到系统提示词中 order 10300 的 `whale-maid:shell-routing` 段（真实组装位于内置 persona suffix 之后）；它优先于工具描述里的泛化建议，但权限/审批/计划模式/文件规则优先。Git Bash 不可用时 Windows 通用任务走绑定的 pwsh，不要改走 WSL bash。不要改宿主 node_modules |
