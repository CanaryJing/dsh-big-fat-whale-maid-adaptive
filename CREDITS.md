# CREDITS — 改编来源与致谢

「大肥鱼女仆长 · 环境自适应模式」是基于以下两个 DSH（DeepSeek Harness）社区插件改编而来，特此向原作者致谢。

> 「风神」「明神」分别是两位作者的名称：风神 = yjh051108（dsh-routing-suite），明神 = xiaobright（dsh-anchored-standard）。

---

## dsh-routing-suite

- **作者**：风神（yjh051108）
- **仓库**：https://github.com/yjh051108/dsh-routing-suite
- **项目描述**：injector + router-standard kit: install the runtime injector first, then the task-aware reasoning-mode router preset (measured P1-P23)
- **本项目借鉴的内容**：
  - 工具按宿主 / 目录世界路由的设计思路（`bash` 直达 WSL、`pwsh` 操作 Windows 母系统、文件工具随世界路由）；
  - 平台分派互斥与 `wsl-` 变体自禁用的经验，避免工具重复注册冲突；
  - 双世界路径互转与 shell 路由的实践参考。

## dsh-anchored-standard

- **作者**：明神（xiaobright）
- **仓库**：https://github.com/xiaobright/dsh-anchored-standard
- **项目描述**：Two-phase DeepSeek Harness preset: Minimal-aligned bootstrap, then full Standard tools (Project2 98/99)
- **本项目借鉴的内容**：
  - 首轮 Minimal 双工具锚定（`bash + str_replace_editor`）与两阶段晋升机制；
  - 抑制自动注入上下文（`agent-instructions` / `skill-catalog`）的「开智」起步思路；
  - 锚定工具缺失时 fail-open 安全降级的健壮性设计。

---

## 说明

- 本项目为社区学习 / 个人使用改编，**非官方 DeepSeek 项目**，与 DeepSeek 无隶属或背书关系。
- 本项目中的 `env-probe.mjs`（环境探测）与 `wsl-bash.mjs`（WSL bash 工具）为原创实现；`agent.cordis.yml` 的组合结构与锚定机制参考上述两个上游项目。
- 两个上游仓库目前均未声明标准开源许可证（`dsh-anchored-standard` 为 Other/NOASSERTION，`dsh-routing-suite` 未声明）。本项目仅作学习参考与致谢，不代为声明其授权条款。
- 如需二次分发本项目，请同时保留本文件与 `readme.md` 中的来源标注。
