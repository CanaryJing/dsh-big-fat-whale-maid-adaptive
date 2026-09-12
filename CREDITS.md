# CREDITS — 来源说明与致谢

**DS女仆长模式**（预设 id：`big-fat-whale-maid-adaptive`）自 **v2.0** 起为独立实现：首轮锚定、统一注入门控、四阶段渐进披露、按需工具解锁等上游方案**已全部移除、不再采用**。

> 「风神」「明神」分别是两位 DSH 社区作者的名称：风神 = yjh051108（dsh-routing-suite），明神 = xiaobright（dsh-anchored-standard）。上游的历史启发与少量仍沿用的通用工具模块，在此致谢。

---

## 一、不再采用的上游方案（v2.0 起移除）

| 上游 | 方案 | 处置 |
|---|---|---|
| dsh-anchored-standard（明神） | 首轮 Minimal 双工具锚定（`tool-bootstrap.mjs`） | **已卸载**，源码备查 |
| dsh-anchored-standard（明神） | 统一注入门控（`context-gate.mjs`） | **已卸载**，源码备查 |
| dsh-anchored-standard（明神） | 按需工具解锁（`dev-tool-search.mjs`） | **已卸载**，源码备查 |
| dsh-routing-suite（风神） | 四阶段渐进工具披露（`router-progressive.mjs` 原实现） | **已移除**，重写为「全量开放 + 交付 gate」 |

---

## 二、仍沿用的通用工具模块（归属与致谢）

- **思维模式路由核心**（`router-core.mjs`）：react / spec / weak 三行为带任务分类、模型感知 persona 叠加句（Flash 模型带三锚）、复杂度启发、`sessionEvents` 兼容——移植自 `dsh-routing-suite` 的 `preset/router-standard/router-core.mjs`（v1.20.0 时代）。
- **交付 gate**（`delivery_check`）：文件存在 / 非空 / UTF-8 + 证据清单校验——移植自 `dsh-routing-suite` 的 `router-bootstrap-v34.mjs`（v1.20 语义）。
- **技能搜索**（`skill-search.mjs`）：`skill_search` / `skill_load` 替代 ~9KB 技能目录注入——移植自 `dsh-anchored-standard`。
- **指令文件短提示**（`instruction-hint.mjs`）：非命令式措辞、randomUUID 唯一 id、全链探测 AGENTS.md / CLAUDE.md——移植自 `dsh-anchored-standard`。
- **epoch 感知晋升追踪**（`compaction-epoch.mjs`）：compaction 边界后回落、snapshotEvents 兼容——移植自 `dsh-anchored-standard`（现供 `instruction-hint.mjs` 使用）。
- **Git Bash 探测经验**（`env-probe.mjs` 的 `detectGitBash`）：安装位置枚举——参考 `dsh-routing-suite`。

---

## 三、说明

- 本项目为社区学习 / 个人使用改编，**非官方 DeepSeek 项目**，与 DeepSeek 无隶属或背书关系。
- 本项目中的 `env-probe.mjs`（环境探测 + 系统环境报告 + gitbash/pwsh 注册）与 `wsl-bash.mjs`（WSL bash 工具）为原创实现。
- 两个上游仓库目前均未声明标准开源许可证（`dsh-anchored-standard` 为 Other/NOASSERTION，`dsh-routing-suite` 未声明）。本项目仅作学习参考与致谢，不代为声明其授权条款。
- 如需二次分发本项目，请同时保留本文件与 `README.md` 中的来源标注。
