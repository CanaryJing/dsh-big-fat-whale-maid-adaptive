/**
 * router-core — 思维模式路由核心（router-standard 移植 · 女仆长适配版）。
 *
 * 从 router-standard/router-core.mjs 移植，适配 big-fat-whale-maid-adaptive：
 *   - personaFor 改为 overlayFor：返回「任务模式叠加句」，由 router-progressive
 *     追加到女仆长 persona 之后（不替换人设）；
 *   - 其余 API 与 router-standard 保持一致（classifyTask / bandOf / parseMode…）。
 *
 * 行为带（实测）：spec [0,0.15] / transition [0.2,0.45]（陷阱）/ react [0.5,1]；
 * weak = 模型自路由（Flash 用 neutral+classify+三锚，Pro 用 spec 句+classify）。
 */

export const MODE_SPEC = 0
export const MODE_MIXED = 0.3
export const MODE_REACT = 1
export const MODE_WEAK = 'weak'

const SPEC_OVERLAY =
  'Task mode (spec): plan first — inspect and understand before changing anything.'
const MIXED_OVERLAY =
  'Task mode (mixed): work directly — prefer writing or editing code over describing plans. Verify your changes by reading and running them.'
const REACT_OVERLAY =
  'Task mode (react): hands-on delivery — write or edit code, then verify by reading and running. Keep the loop tight: produce, verify, fix. Do not build test harnesses, scaffolding, or ceremony the user did not ask for.'
const WEAK_PRO_OVERLAY =
  'Before acting, decide the task type (build or fix) and adopt the matching style: build → hands-on production; fix → inspect-and-plan.'
const WEAK_FLASH_OVERLAY =
  'Before acting, decide the task type (build or fix) and adopt the matching style: build → hands-on production; fix → inspect-and-plan. Before acting, briefly review what you have already done in this session and continue from where you left off; do not repeat completed steps. Do not run environment checks (echo, whoami, uname, node --version, date) or exhaustive grep/glob scans. Think deeply first, then produce.'

const COMPLEX_RE = /(重构|架构|全面|详细|设计|系统|优化|分析|survey|overview|architecture|refactor|comprehensive|detailed|design|system|optimize|analyze)/i

export function isComplexTask(text) {
  return typeof text === 'string' && (text.length > 120 || COMPLEX_RE.test(text))
}

export function isFlashModel(modelId) {
  return typeof modelId === 'string' && /flash/i.test(modelId)
}

export function bandOf(mode) {
  if (mode === 'weak') return 'weak'
  const m = clamp01(mode)
  if (m < 0.2) return 'spec'
  if (m < 0.5) return 'transition'
  return 'react'
}

export function overlayFor(mode, modelId) {
  switch (bandOf(mode)) {
    case 'spec': return SPEC_OVERLAY
    case 'transition': return MIXED_OVERLAY
    case 'weak': return isFlashModel(modelId) ? WEAK_FLASH_OVERLAY : WEAK_PRO_OVERLAY
    default: return REACT_OVERLAY
  }
}

export function coreFor(mode) {
  switch (bandOf(mode)) {
    case 'spec': return ['read', 'edit', 'glob', 'grep']
    case 'transition': return ['read', 'edit', 'write', 'glob', 'grep']
    case 'weak': return ['str_replace_editor']
    default: return ['read', 'write', 'edit']
  }
}

export function bandFor(mode) {
  const b = bandOf(mode)
  return b === 'transition' ? 'mixed' : b
}

export function testinessFor(mode) {
  switch (bandOf(mode)) {
    case 'react': return 'suppressed'
    case 'spec': return 'normal'
    default: return 'light'
  }
}

const REACT_RE = /(开发|创建|写一个|生成|从零|做一个|游戏|网页|网站|构建|新项目|搭建|实现|做出|上线|落地|脚本|工具|应用|build|create|develop|generate|implement|make a|new project)/gi
const SPEC_RE = /(修复|修一下|调试|重构|维护|排查|报错|出错|崩溃|优化|审查|review|fix|debug|refactor|maintain|repair|broken|break|为什么|异常|故障|迁移|升级|兼容)/gi

function countHits(regex, text) {
  return [...text.matchAll(regex)].length
}

export function classifyTask(text) {
  const react = countHits(REACT_RE, text)
  const spec = countHits(SPEC_RE, text)
  if (react > spec) return 1
  if (spec > react) return 0
  return 'weak'
}

export function sessionEvents(session) {
  if (!session) return []
  if (Array.isArray(session.events)) return session.events
  if (typeof session.snapshotEvents === 'function') {
    try { return session.snapshotEvents() } catch { return [] }
  }
  return []
}

export function sessionMode(session) {
  const events = sessionEvents(session)
  const userMsg = events.find((e) => e.type === 'user/message' && e.data?.source?.kind !== 'plugin')
    ?? events.find((e) => e.type === 'user/message')
  return classifyTask(extractText(userMsg?.data))
}

export function extractText(data) {
  if (!data) return ''
  const payload = data && typeof data.message === 'object' && data.message !== null ? data.message : data
  const content = Array.isArray(payload.content) ? payload.content : []
  return content.map((c) => (typeof c === 'string' ? c : (c.text ?? ''))).join(' ')
}

export function advanceStage(stage, toolNames, text) {
  const names = Array.isArray(toolNames) ? toolNames : []
  const words = typeof text === 'string' ? text : ''
  let s = stage
  if (s === 0 && (names.includes('todo_write') || /开始开发|进入开发|着手实现|开始实现|write the code/i.test(words))) s = 1
  if (s === 1 && names.some((n) => ['write', 'edit', 'str_replace_editor'].includes(n))) s = 2
  if (s === 2 && (names.includes('gitbash') || names.includes('pwsh') || names.includes('bash') || /完成|finished|done|验证/i.test(words))) s = 3
  return s
}

export function clamp01(v) {
  return Math.min(1, Math.max(0, Number(v) || 0))
}

export function applyPersona(sections, personaText) {
  const rest = (sections || []).filter(
    (section) => section.name !== 'persona' && !/persona/i.test(section.name),
  )
  return [...rest, { name: 'router-persona', text: personaText, order: 0 }]
}

export function parseMode(token) {
  if (token === undefined || token === null) return null
  const t = String(token).trim().toLowerCase()
  if (t === 'auto') return 'auto'
  if (t === 'weak' || t === 'router') return 'weak'
  if (t === 'spec' || t === 'spec-lean') return 0
  if (t === 'balanced' || t === 'mixed') return 0.3
  if (t === 'react' || t === 'react-lean') return 1
  const n = Number(t)
  if (!Number.isFinite(n)) return null
  if (t.includes('.')) return clamp01(n)
  return clamp01(n / 100)
}
