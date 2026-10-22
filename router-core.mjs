/**
 * router-core — 思维模式路由核心（router-standard 移植 · 女仆长适配版）。
 *
 * 从 router-standard/router-core.mjs 移植，适配 big-fat-whale-maid-adaptive：
 *   - personaFor 改为 overlayFor：返回「任务模式叠加句」，由 router-progressive
 *     追加到女仆长 persona 之后（不替换人设）；
 *   - 其余 API 与 router-standard 保持一致（classifyTask / bandOf / parseMode…）。
 *
 * 行为带（实测）：spec [0,0.15] / transition [0.2,0.45]（陷阱）/ react [0.5,1]；
 * consult 是只读/解释/评审/先给计划带；weak = 模型自路由。
 *
 * v3.1.0 起 sessionMode 逆序取「最近真实用户实质请求」：自动通知、插件消息、
 * 记忆/runtime 包装块（含多段 Current runtime context）、代码/引用块不参与
 * 意图判断；最近一条只是「继续/好的/可以」等简短应承时，沿用上一条实质任务。
 * 明确问句优先于实施动词；「只做这个错误的修复」「修复这个错误，不要改其他
 * 文件」属于范围限制，仍走实施。没有任何可靠意图时返回 weak，不默认 react。
 */

export const MODE_SPEC = 0
export const MODE_MIXED = 0.3
export const MODE_REACT = 1
export const MODE_WEAK = 'weak'
export const MODE_CONSULT = 'consult'

const MODE_BOUNDARY =
  '\n\nRouting note: this is a style hint only; it grants no permissions. Explicit user instructions, plan mode, and approval rules take precedence.'

const SPEC_OVERLAY =
  'Task mode (spec): plan first — inspect and understand before changing anything.'
const MIXED_OVERLAY =
  'Task mode (mixed): work directly — prefer writing or editing code over describing plans. Verify your changes by reading and running them.'
const REACT_OVERLAY =
  'Task mode (react): hands-on delivery — write or edit code, then verify by reading and running. Keep the loop tight: produce, verify, fix. Do not build test harnesses, scaffolding, or ceremony the user did not ask for.'
const CONSULT_OVERLAY =
  'Task mode (consult): answer the question — explain, review, assess, or plan without writing or editing files. Do not start implementation or prompt for code changes; stay read-only until the user explicitly asks for implementation.'
const WEAK_PRO_OVERLAY =
  'Before acting, decide the task type (build, fix, or consult) and adopt the matching style: build → hands-on production; fix → inspect-and-plan; consult → read-only answer or plan. If the request is only a question or intent is unclear, answer or inspect instead of assuming implementation.'
const WEAK_FLASH_OVERLAY =
  'Before acting, decide the task type (build, fix, or consult) and adopt the matching style: build → hands-on production; fix → inspect-and-plan; consult → read-only answer or plan. If the request is only a question or intent is unclear, answer or inspect instead of assuming implementation. Before acting, briefly review what you have already done in this session and continue from where you left off; do not repeat completed steps. Do not run environment checks (echo, whoami, uname, node --version, date) or exhaustive grep/glob scans. Think deeply first, then produce.'

const COMPLEX_RE = /(重构|架构|全面|详细|设计|系统|优化|分析|survey|overview|architecture|refactor|comprehensive|detailed|design|system|optimize|analyze)/i

// ── 文本清洗 ────────────────────────────────────────────────────────────────

const CONTEXT_TAGS =
  'openviking(?:[-_ ]?(?:context|memory))?|memory[-_ ]?context|runtime[-_ ]?context|context[-_ ]?snapshot|system[-_ ]?context|agent[-_ ]?context'
const CONTEXT_XML_RE = new RegExp(`<(${CONTEXT_TAGS})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, 'gi')
const CONTEXT_XML_SELF_RE = new RegExp(`<(${CONTEXT_TAGS})\\b[^>]*\\/\\s*>`, 'gi')
const CONTEXT_BRACKET_RE = new RegExp(`\\[(${CONTEXT_TAGS})\\][\\s\\S]*?\\[\\/\\1\\s*\\]`, 'gi')
// The runtime snapshot is a multi-paragraph block appended to the real user
// request. Strip it as a whole to end of message: deleting only its heading
// paragraph would leave "Current working directory…" / "You are…" behind and
// let those wrapper lines override the real task.
const RUNTIME_CONTEXT_BLOCK_RE = /^\s*Current runtime context\.[\s\S]*$/gim

/** 去掉记忆/runtime 等「包装块」，但保留同一消息里包装外的真实请求。 */
export function stripContextBlocks(text) {
  if (typeof text !== 'string' || text.length === 0) return ''
  return text
    .replace(CONTEXT_XML_RE, ' ')
    .replace(CONTEXT_XML_SELF_RE, ' ')
    .replace(CONTEXT_BRACKET_RE, ' ')
    .replace(RUNTIME_CONTEXT_BLOCK_RE, ' ')
    .trim()
}

/** 意图判断时忽略代码块、行内代码、引用块，避免 quote/code 里的动词误触发。 */
export function stripQuotedAndCode(text) {
  if (typeof text !== 'string' || text.length === 0) return ''
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, ' ')
    .replace(/<code\b[^>]*>[\s\S]*?<\/code>/gi, ' ')
    .replace(/<(quote|quoted|previous_response|assistant_quote)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/`[^`\n]+`/g, ' ')
    .trim()
}

/** 从 UserMessage data 中取文本，兼容 data.content / data.message.content / 旧 data.text。 */
export function extractText(data) {
  if (!data || typeof data !== 'object') return ''
  const payload =
    data.message && typeof data.message === 'object' && data.message !== null ? data.message : data
  const content = payload.content !== undefined ? payload.content : data.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block
        if (block && typeof block.text === 'string') return block.text
        return ''
      })
      .join('\n')
  }
  if (typeof payload.text === 'string') return payload.text
  if (typeof data.text === 'string') return data.text
  return ''
}

const LEGACY_USER_TYPES = new Set(['user'])

/** 来源白名单：真实用户（kind=user）或旧数据（没有 source/kind）。 */
export function isHumanUserMessage(data) {
  if (!data || typeof data !== 'object') return false
  const source = data.source ?? data.message?.source
  if (source === undefined || source === null) return true
  if (typeof source !== 'object') return false
  if (source.kind === undefined || source.kind === null) {
    return source.type === undefined || LEGACY_USER_TYPES.has(source.type)
  }
  return source.kind === 'user'
}

/** 取一条 user/message 中真正来自用户的请求文本（已去包装块）。 */
export function extractUserRequestText(data) {
  return stripContextBlocks(extractText(data))
}

const ACK_TOKENS = new Set([
  '继续', '继续吧', '继续做', '继续干', '好', '好的', '好哒', '好呀', '可以', '行', '嗯', '嗯嗯',
  '收到', '明白', '明白了', '了解', '谢谢', '谢谢啦', '辛苦了', '没问题', 'ok', 'okay', 'yes',
  'yep', 'sure', 'continue', 'proceed', 'go', 'go on', 'thanks', 'thank you', 'got it',
])

/** 「继续/好的/可以」等简短应承：不携带新的任务类型，沿用上一条实质任务。 */
export function isBareAcknowledgement(text) {
  if (typeof text !== 'string') return false
  const normalized = stripQuotedAndCode(stripContextBlocks(text))
    .toLowerCase()
    .replace(/[\s。！!，,、；;：:~～.]+/g, ' ')
    .trim()
  if (normalized.length === 0) return false
  const tokens = normalized.split(' ').filter(Boolean)
  if (tokens.length > 3) return false
  return tokens.every((token) => ACK_TOKENS.has(token))
}

// ── 意图识别 ────────────────────────────────────────────────────────────────

// English alternatives are word-bounded so "address" is not "add", "prefix"
// is not "fix", and "somehow" is not "how". Chinese alternatives need no
// boundaries. Keeping the two families separate avoids a \b next to a CJK
// character, where JavaScript word boundaries are not meaningful.
const IMPLEMENT_VERB_SOURCE =
  '实现|修复|修一下|修改|改成|改为|写一?个?|创建|开发|构建|搭建|新增|添加|删除|移除|重构|优化|维护|排查|生成|迁移|升级|替换|部署|上线|落地|做一个|做个|搞一个|弄一个|来一个'
  + '|\\b(?:implement|implementing|fix|debug|refactor|modify|edit|write|create|build|adding|add|remove|delete|migrate|upgrade|patch|deploy)\\b'
const IMPLEMENT_VERB_RE = new RegExp(IMPLEMENT_VERB_SOURCE, 'gi')
const NEGATION_BEFORE_RE = /(?:不|别|勿|无需|不用|不需要|没必要|不要|禁止|未|没|\bno|\bnot|don'?t|\bwithout)\s*$/i

// A scope limit is not a blanket "don't implement" instruction: "只做这个
// 错误的修复" and "修复这个错误，不要改其他文件" still request a fix. The
// blocker patterns below therefore ignore a negated edit whose object is
// explicitly "other/unrelated" files or changes.
const SCOPE_LIMIT_TAIL_ZH = '(?![\\s\\S]{0,14}?(?:其他|其它|别的|无关|别处))'
const SCOPE_LIMIT_TAIL_EN = '(?![^.!?;]{0,28}?\\b(?:other|unrelated|elsewhere)\\b)'

/** 是否存在未被否定词修饰的实施动词。 */
function hasUnnegatedImplementation(text) {
  for (const match of text.matchAll(IMPLEMENT_VERB_RE)) {
    const index = match.index ?? 0
    const before = text.slice(Math.max(0, index - 8), index)
    if (!NEGATION_BEFORE_RE.test(before)) return true
  }
  return false
}

// 强约束：只给/先给计划、只读、明确不要写，一律 consult，即使句子里还有别的动词。
// 「不要改其他文件」是范围限制，不是拒绝实施；它由 SCOPE_LIMIT_TAIL_* 排除。
const CONSULT_BLOCKER_RE = new RegExp([
  '只(?:给|要|需|读|看|解释|说明|分析|评审|评估|列|输出|提供)',
  '先(?:给|出)(?:个|一份|一下)?(?:计划|方案|结论|设想)',
  '先(?:解释|说明|分析|评估|评审)',
  `不要(?:写|改|修改|动|实现|执行|提交)${SCOPE_LIMIT_TAIL_ZH}`,
  `不用(?:写|改|实现)${SCOPE_LIMIT_TAIL_ZH}`,
  `别(?:写|改|动|提交)${SCOPE_LIMIT_TAIL_ZH}`,
  `禁止(?:写|改|修改)${SCOPE_LIMIT_TAIL_ZH}`,
  '只读|read[- ]only|plan[- ]only|only (?:a |the )?plan',
  'no (?:code|changes?|edits?)',
  `without (?:writing|editing|changing)${SCOPE_LIMIT_TAIL_EN}`,
  `don'?t (?:write|edit|change|implement|touch)${SCOPE_LIMIT_TAIL_EN}`,
  `do not (?:write|edit|change|implement|touch)${SCOPE_LIMIT_TAIL_EN}`,
].join('|'), 'i')

// 强咨询信号：解释/评审/分析/给计划。默认 consult；只有明确「解释并修复」
// 这类并列实施句才让实施优先。
const CONSULT_STRONG_SOURCE =
  '咨询|请教|解释|说明|评审|评估|分析|(?:给|出|列|做|制定)(?:我)?(?:个|一个|一份|一下)?(?:计划|方案|规划)'
  + '|\\b(?:review|explain|assess|evaluate|consult)\\b'
const CONSULT_STRONG_RE = new RegExp(CONSULT_STRONG_SOURCE, 'i')
const CONSULT_IMPL_COORDINATION_RE = new RegExp(
  `(?:${CONSULT_STRONG_SOURCE})[\\s\\S]{0,16}?(?:并|然后|接着|再|之后|同时|and|then)[\\s\\S]{0,10}?(?:${IMPLEMENT_VERB_SOURCE})`
  + `|(?:${IMPLEMENT_VERB_SOURCE})[\\s\\S]{0,16}?(?:并|然后|接着|再|之后|同时|and|then)[\\s\\S]{0,10}?(?:${CONSULT_STRONG_SOURCE})`,
  'i',
)

// 明确问句优先于实施动词：「如何修复这个错误？」/「Why create this file?」
// 问的是方法或原因，不是让人立刻动手。English wh-words are word-bounded and
// must start a clause so "somehow"/"show" never trigger this branch.
const QUESTION_RE =
  /(?:如何|为什么|为何|怎么会|怎么(?:样|办|解决|处理|才能|去|做)?|怎样|是什么|什么意思|做什么|干什么|有哪些|有何|是否|能否)|(?:^|[\s，。；;：:!！?？])(?:how|why|what|where|when|which|who|whose|whom)\b/i

// 弱咨询信号：提问/看看；若同句有未否定的实施动词，实施优先。
const CONSULT_SIGNAL_RE =
  /(看看|看一下|读一下|为什么|为何|是什么|什么意思|怎么用|如何使用|怎么(?:办|解决|处理|理解)|是否|能不能|可不可以|如何理解|what is|how does|how do i use|why)/i

const REACT_RE = /(开发|创建|写一个|生成|从零|做一个|游戏|网页|网站|构建|新项目|搭建|实现|做出|上线|落地|脚本|工具|应用|build|create|develop|generate|implement|make a|new project)/gi
const SPEC_RE = /(修复|修一下|调试|重构|维护|排查|报错|出错|崩溃|优化|fix|debug|refactor|maintain|repair|broken|break|异常|故障|迁移|升级|兼容)/gi

function countHits(regex, text) {
  return [...text.matchAll(regex)].length
}

export function isComplexTask(text) {
  return typeof text === 'string' && (text.length > 120 || COMPLEX_RE.test(text))
}

export function isFlashModel(modelId) {
  return typeof modelId === 'string' && /flash/i.test(modelId)
}

export function bandOf(mode) {
  if (mode === 'weak' || mode === 'consult') return mode
  const m = clamp01(mode)
  if (m < 0.2) return 'spec'
  if (m < 0.5) return 'transition'
  return 'react'
}

export function overlayFor(mode, modelId) {
  let overlay
  switch (bandOf(mode)) {
    case 'spec': overlay = SPEC_OVERLAY; break
    case 'transition': overlay = MIXED_OVERLAY; break
    case 'consult': overlay = CONSULT_OVERLAY; break
    case 'weak': overlay = isFlashModel(modelId) ? WEAK_FLASH_OVERLAY : WEAK_PRO_OVERLAY; break
    default: overlay = REACT_OVERLAY
  }
  return overlay + MODE_BOUNDARY
}

export function coreFor(mode) {
  switch (bandOf(mode)) {
    case 'spec': return ['read', 'edit', 'glob', 'grep']
    case 'transition': return ['read', 'edit', 'write', 'glob', 'grep']
    case 'consult': return ['read', 'glob', 'grep']
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
    case 'consult': return 'normal'
    case 'spec': return 'normal'
    default: return 'light'
  }
}

/**
 * 分类用户意图。先清洗包装块/引用/代码，再按以下优先级：
 *   1. 明确只读/只给计划/不要写 → consult；
 *   2. 明确问句（如何/为什么/how/what…）→ consult，即使含实施动词；
 *   3. 解释/评审/分析（没有「解释并修复」这类并列实施句）→ consult；
 *   4. 未被否定的实施动词 → 现有 react/spec 计数（不是一律 consult）；
 *      范围限制（只做这个修复/不要改其他文件）不构成 consult blocker；
 *   5. 弱咨询/提问 → consult；
 *   6. 无可靠意图 → weak（中性，不默认 react）。
 */
export function classifyTask(text) {
  const raw = stripQuotedAndCode(stripContextBlocks(typeof text === 'string' ? text : ''))
  if (raw.length === 0) return MODE_WEAK

  if (CONSULT_BLOCKER_RE.test(raw)) return MODE_CONSULT

  // A genuine question asks for understanding, even when it contains a verb
  // like fix/build/create. Explicit read-only/plan-only blockers above still
  // win; a coordinated "解释并修复" is not a question and keeps implementing.
  if (QUESTION_RE.test(raw)) return MODE_CONSULT

  if (CONSULT_STRONG_RE.test(raw) && !CONSULT_IMPL_COORDINATION_RE.test(raw)) {
    return MODE_CONSULT
  }

  if (hasUnnegatedImplementation(raw)) {
    const react = countHits(REACT_RE, raw)
    const spec = countHits(SPEC_RE, raw)
    if (react > spec) return MODE_REACT
    if (spec > react) return MODE_SPEC
    if (react > 0) {
      // 明确的实施意图优先于「中性 weak」：按最后一个未被否定的实施动词
      // 决定 build（react）还是 fix/maintain（spec）。
      const verbs = [...raw.matchAll(IMPLEMENT_VERB_RE)]
      const last = String(verbs.at(-1)?.[0] ?? '')
      if (/(修复|修一下|调试|重构|维护|排查|优化|fix|debug|refactor|maintain|repair|patch)/i.test(last)) {
        return MODE_SPEC
      }
      return MODE_REACT
    }
    return MODE_WEAK
  }

  if (CONSULT_SIGNAL_RE.test(raw)) return MODE_CONSULT

  // 没有实施动词、没有咨询信号：即使句子里出现「工具/应用/脚本」等名词，
  // 也不自动当成 react；留给模型自路由。
  return MODE_WEAK
}

export function sessionEvents(session) {
  if (!session) return []
  if (Array.isArray(session.events)) return session.events
  if (typeof session.snapshotEvents === 'function') {
    try {
      return session.snapshotEvents()
    } catch {
      return []
    }
  }
  return []
}

/**
 * 逆序找最近一条真实用户实质请求；简短应承跳过并沿用上一实质任务。
 * 只允许用户来源或旧无 source 数据，自动通知/插件/记忆包装一律不计。
 */
export function sessionRequestText(session) {
  const events = sessionEvents(session)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'user/message') continue
    if (!isHumanUserMessage(event.data)) continue
    const text = extractUserRequestText(event.data)
    if (text.length === 0) continue
    if (isBareAcknowledgement(text)) continue
    return text
  }
  return ''
}

export function sessionMode(session) {
  return classifyTask(sessionRequestText(session))
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
  if (t === 'consult' || t === 'advice' || t === 'ask' || t === 'explain' || t === 'readonly' || t === 'read-only') return 'consult'
  if (t === 'spec' || t === 'spec-lean') return 0
  if (t === 'balanced' || t === 'mixed') return 0.3
  if (t === 'react' || t === 'react-lean') return 1
  const n = Number(t)
  if (!Number.isFinite(n)) return null
  if (t.includes('.')) return clamp01(n)
  return clamp01(n / 100)
}
