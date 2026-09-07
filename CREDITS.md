# CREDITS — 改编来源与致谢

「大肥鱼女仆长 · 环境自适应模式」是基于以下两个 DSH（DeepSeek Harness）社区插件改编而来，特此向原作者致谢。

> 「风神」「明神」分别是两位作者的名称：风神 = yjh051108（dsh-routing-suite），明神 = xiaobright（dsh-anchored-standard）。

---

## dsh-routing-suite

- **作者**：风神（yjh051108）
- **仓库**：https://github.com/yjh051108/dsh-routing-suite
- **项目描述**：injector + router-standard kit: install the runtime injector first, then the task-aware reasoning-mode router preset (measured P1-P23)
- **本项目借鉴的内容**：
  - **思维模式路由**（`router-core.mjs`）：react / spec / weak 三行为带任务分类、模型感知 persona 叠加句（Flash=neutral+classify+三锚）、复杂度启发、`sessionEvents` 兼容——移植自 `preset/router-standard/router-core.mjs`（远端 HEAD，v1.20.0 时代）；
  - **渐进式工具披露**（`router-progressive.mjs`）：四阶段闯关（了解 → 方案 → 开发 → 验证）、预解锁归零（`windowFor = stage+1`）、阶段持久化、`delivery_check` 交付 gate、`tools_catalog` / `tools_help` / `dev_router_status` / `phase_advance`——移植自 `preset/router-standard/router-bootstrap-v34.mjs`（v1.20 语义，适配女仆长 + gitbash/pwsh 路由，移除 dev_router_mode / dev_page_check / PTC）；
  - Git Bash 探测经验（`env-probe.mjs` 的 `detectGitBash`：Program Files / x86 / 每用户安装位置枚举）。

## dsh-anchored-standard

- **作者**：明神（xiaobright）
- **仓库**：https://github.com/xiaobright/dsh-anchored-standard
- **项目描述**：Two-phase DeepSeek Harness preset: Minimal-aligned bootstrap, then full Standard tools (Project2 98/99)
- **本项目借鉴的内容**：
  - **首轮 Minimal 双工具锚定**（`tool-bootstrap.mjs`）：`bash + str_replace_editor` 锚定、`promoteOn: either`、`bootstrapMaxTokens` 可选、fail-open 降级——移植自 `preset/tool-bootstrap.mjs`（远端 HEAD；改造：晋升后放行全量，交给 router-progressive 渐进披露）；
  - **统一注入门控**（`context-gate.mjs`）：runtime-context blanking + pre-step claimed-baseline deny、`allowKinds`、compaction/end 重关——直接移植自 `preset/context-gate.mjs`；
  - **epoch 感知晋升**（`compaction-epoch.mjs`）：compaction 边界后回落、snapshotEvents 兼容——直接移植自 `preset/compaction-epoch.mjs`；
  - **按需工具解锁**（`dev-tool-search.mjs`）：评分搜索 + 按名解锁——直接移植自 `preset/dev-tool-search.mjs`；
  - **技能搜索**（`skill-search.mjs`）：`skill_search` / `skill_load` 替代 ~9KB 技能目录注入——直接移植自 `preset/skill-search.mjs`；
  - **指令文件短提示**（`instruction-hint.mjs`）：非命令式措辞、randomUUID 唯一 id、全链探测 AGENTS.md/CLAUDE.md——直接移植自 `preset/instruction-hint.mjs`。

---

## 说明

- 本项目为社区学习 / 个人使用改编，**非官方 DeepSeek 项目**，与 DeepSeek 无隶属或背书关系。
- 本项目中的 `env-probe.mjs`（环境探测 + gitbash/pwsh 注册 + 英文简报）与 `wsl-bash.mjs`（WSL bash 工具）为原创实现；`agent.cordis.yml` 的组合结构参考上述两个上游项目。
- 两个上游仓库目前均未声明标准开源许可证（`dsh-anchored-standard` 为 Other/NOASSERTION，`dsh-routing-suite` 未声明）。本项目仅作学习参考与致谢，不代为声明其授权条款。
- 如需二次分发本项目，请同时保留本文件与 `README.md` 中的来源标注。
