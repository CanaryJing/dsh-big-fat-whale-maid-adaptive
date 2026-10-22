/**
 * shell-policy — 预设内唯一的 shell 路由规则源（v3.1.0）。
 *
 * Windows 通用执行优先 Git Bash；Git Bash 不可用时由已验证/绑定的 pwsh 处理
 * Windows 通用任务，pwsh 同时用于 PowerShell 专属命令、.ps1 与 Windows UI
 * 自动化；bash 只用于 Linux-only 工作，绝不作为 Windows 回退；原生
 * Linux/macOS/Android 使用 native shell。ops_bash 只在适用环境与能力明确时
 * 作为执行入口，不与 Windows 的 gitbash 首选项竞争。目录非法停止；命令失败
 * 不换旧 PowerShell/不同 shell；权限拒绝不可越过。
 *
 * 环境简报与系统提示词段都从这里取同一份字符串/函数，避免两处各写一句后
 * 慢慢漂移。宿主外部插件的泛化 shell 提示不可修改；本预设的独立靠后 section
 * 明确声明自己的具体路由优先于那些泛化建议，但仍低于权限、审批、沙箱与
 * 文件规则。
 */

export const SHELL_ROUTING_SUMMARY = [
  'Windows general execution: prefer gitbash first.',
  'On Windows, when Git Bash is unavailable, the verified bound pwsh tool handles general Windows tasks; pwsh is also the choice for PowerShell-specific commands, .ps1 scripts, or Windows UI automation.',
  'Use bash only for Linux-only work; it is never the Windows fallback. Native Linux/macOS/Android use their native shell.',
  'ops_bash is an execution entry point only when its environment and capability are explicitly applicable; it does not compete with the Windows gitbash preference.',
  'An invalid or unsupported workdir stops execution; a failed command never switches to an older PowerShell or a different shell, and a permission/approval denial is never bypassed.',
].join(' ')

export const SHELL_ROUTING_SECTION = [
  'Shell routing (preset-specific, applied after generic tool guidance):',
  SHELL_ROUTING_SUMMARY,
  'This is the single source of truth for shell selection; do not restate or override it from the persona.',
  'This concrete routing takes precedence over generic shell-first suggestions in tool descriptions. It never grants permission and never overrides plan mode, approval, sandbox, or file rules.',
].join('\n')

export const SHELL_ROUTING_SECTION_NAME = 'whale-maid:shell-routing'
// 10300 sits after every built-in section the engine registers, notably
// WEB_SURFACE (10100) and DEPLOYMENT_PERSONA_SUFFIX (10200). An order of 90
// only looked late among our own mock sections; it did not place this rule
// after the real host prompt. Verify with a real SystemPrompt assembly test.
export const SHELL_ROUTING_SECTION_ORDER = 10300

/**
 * 注册独立、靠后的 shell 路由系统段。只依赖 ctx.effect / ctx.systemPrompt；
 * 测试可用最小 mock 验证真实 section 形态与 order。
 * @returns {boolean} 是否成功声明 section。
 */
export function registerShellPolicy(ctx, options = {}) {
  if (ctx?.systemPrompt?.section === undefined) return false
  const order = Number.isSafeInteger(options.order) ? options.order : SHELL_ROUTING_SECTION_ORDER
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => ctx.systemPrompt.section({
      name: SHELL_ROUTING_SECTION_NAME,
      order,
      text: SHELL_ROUTING_SECTION,
    }))
  } else {
    ctx.systemPrompt.section({ name: SHELL_ROUTING_SECTION_NAME, order, text: SHELL_ROUTING_SECTION })
  }
  return true
}
