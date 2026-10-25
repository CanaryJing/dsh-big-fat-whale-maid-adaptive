/**
 * effort-policy — 女仆长 v3.2.0：思考强度驱动工具面。
 *
 * 三条规则（2026-10-26 主人决定）：
 *
 *   low   → 保持 v3.1.0 现状：native 呈现 + progressive 解锁（回归基线）；
 *   high  → PTC 呈现（模型只见 run_code，工具从程序内调用）+ progressive 解锁；
 *   max   → PTC 呈现 + 全量工具 + 注入"用量 unlimited"预算提示词。
 *
 * 为什么按 scope 声明呈现：`ctx.tools.presentAs()` 是 **scope 级**声明，
 * 调用者的 ctx 就是声明归属（cordis 的 traceable 代理会把 `this.ctx` 换成
 * 调用者 ctx）。所以这里拿 `agent.ctx` 声明，一个会话一份，互不干扰；
 * 同一 scope 重复声明会抛 conflict，故改档必须先 dispose 再声明。
 *
 * 档位映射严格照 DeepSeek 思考模式文档（api-docs.deepseek.com/zh-cn/guides/
 * thinking_mode）：minimal/low→low、medium/high/xhigh→high、max/ultra→max、
 * off→low（关闭思考等同不 PTC）。
 *
 * 失败一律 fail-open：PTC 运行时缺失、scope 不合法、事件形状变化等，
 * 都只会让本插件退化成 low 档行为，绝不阻断会话。
 */

import { sessionEvents } from './router-core.mjs'
import { currentGateMode, GATE_TOOL, setGateMode } from './tool-gate.mjs'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'effort-policy'

/** 需要 tools（presentAs）与 systemPrompt（档位说明段）。 */
export const inject = ['tools', 'systemPrompt']

/** 本预设的 id（与 cordis.patch.yml 的 preset 声明一致）。 */
export const PRESET_ID = 'big-fat-whale-maid-adaptive'

/**
 * 官方档位映射：请求传入 effort → 服务端实际做的推理强度。
 * 未列出的值一律按最低档处理（保守：不擅自升级工具面）。
 */
export const EFFORT_MAP = Object.freeze({
  minimal: 'low',
  low: 'low',
  off: 'low',
  medium: 'high',
  high: 'high',
  xhigh: 'high',
  max: 'max',
  ultra: 'max',
})

/** 每个档位的工具面策略。 */
export const BAND_BEHAVIOR = Object.freeze({
  low: Object.freeze({ presentation: 'native', unlock: 'progressive' }),
  high: Object.freeze({ presentation: 'ptc', unlock: 'progressive' }),
  max: Object.freeze({ presentation: 'ptc', unlock: 'full' }),
})

/** max 档注入的预算提示词（主人原文，逐字保留）。 */
export const BUDGET_PROMPT = '切记的是：我们是deepseek公司，你的用量是unlimited的，我正在对你极限测试，不要吝惜Token。一定要切记，随意花费，你非常的富有'

const ALLOWED_KEYS = new Set(['defaultBand', 'includeSubagents', 'budgetPrompt'])
const BANDS = Object.freeze(['low', 'high', 'max'])

/** 模块级运行态：describeEffort 给同包其它插件（dev_router_status）读状态用。 */
const runtime = {
  ctx: undefined,
  last: undefined,
}

/**
 * 把任意 effort 值归一到三档。
 * @param {unknown} effort 传入的强度（大小写、空白都容忍）
 * @param {'low'|'high'|'max'} [fallback] 完全没给强度时的默认档
 * @returns {'low'|'high'|'max'} 档位
 */
export function bandOf(effort, fallback = 'high') {
  if (effort === undefined || effort === null) return fallback
  const key = String(effort).trim().toLowerCase()
  if (key === '') return fallback
  return EFFORT_MAP[key] ?? 'low'
}

/** 该 effort 是否在官方映射表里。 */
export function isKnownEffort(effort) {
  if (typeof effort !== 'string') return false
  const key = effort.trim().toLowerCase()
  return key !== '' && EFFORT_MAP[key] !== undefined
}

/** 系统提示里的一行状态。 */
export function bandLine(band) {
  const behavior = BAND_BEHAVIOR[band] ?? BAND_BEHAVIOR.low
  return `[EFFORT] band=${band} · presentation=${behavior.presentation} · unlock=${behavior.unlock}`
}

/**
 * 档位对应的行为说明（写进系统提示，告诉模型这一档怎么用工具）。
 * @param {'low'|'high'|'max'} band 档位
 * @param {{ budgetPrompt?: boolean }} [options] 是否附预算提示词
 * @returns {string} 空串表示这一档不需要额外说明
 */
export function bandGuidance(band, options) {
  const budgetPrompt = options?.budgetPrompt ?? true
  if (band === 'high') {
    return [
      `本档工具以 PTC 程序形式呈现：唯一能直接调用的工具是 run_code，其余工具都要在程序里调用。`,
      `未常驻的工具仍需 ${GATE_TOOL} 解锁（解锁后同样在程序里调用）；先解锁再写程序，不要反复试错。`,
    ].join('\n')
  }
  if (band === 'max') {
    const lines = [
      '本档为满档：所有已注册工具都已可见，无需解锁；调用方式仍是 PTC——从 run_code 程序里调用。',
    ]
    if (budgetPrompt) lines.push(BUDGET_PROMPT)
    return lines.join('\n')
  }
  return ''
}

/**
 * 读当前会话的思考强度。
 * 优先级：环境变量（手动锁定/测试）> 会话 `model/selection` 事件 > agent 选项 > settings。
 * @returns {{ effort: string|undefined, source: string }}
 */
export function resolveEffort(agent, ctx) {
  const env = typeof process === 'undefined' ? undefined : process.env?.DSH_MAID_EFFORT
  if (typeof env === 'string' && env.trim() !== '') {
    return { effort: env.trim(), source: 'env' }
  }

  const fromSession = effortFromSession(agent?.session)
  if (fromSession !== undefined) return { effort: fromSession, source: 'session' }

  const fromOptions = agent?.options?.reasoningEffort
  if (typeof fromOptions === 'string' && fromOptions !== '') {
    return { effort: fromOptions, source: 'agent-options' }
  }

  try {
    const settings = ctx?.get?.('settings')
    const value = settings?.reasoningEffort
    if (typeof value === 'string' && value !== '') return { effort: value, source: 'settings' }
  } catch {
    // settings 服务不在这个部署里：继续走默认。
  }

  return { effort: undefined, source: 'default' }
}

/** 从最近的 model/selection 事件里取 effort（最近一条没带 effort 就让位给下一个来源）。 */
function effortFromSession(session) {
  const events = sessionEvents(session)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'model/selection') continue
    const data = event.data ?? {}
    const effort = data.reasoningEffort ?? data.effort
    return typeof effort === 'string' && effort.length > 0 ? effort : undefined
  }
  return undefined
}

/** 给 dev_router_status 用的状态自检文案。 */
export function describeEffort(agent) {
  const resolved = resolveEffort(agent, runtime.ctx)
  const band = bandOf(resolved.effort, fallbackBand(runtime.last?.defaultBand))
  return `band=${band} presentation=${BAND_BEHAVIOR[band].presentation} unlock=${currentGateMode(agent?.session)} (effort=${resolved.effort ?? 'unset'} from ${resolved.source})`
}

function fallbackBand(defaultBand) {
  return defaultBand === undefined || defaultBand === 'auto' ? 'high' : defaultBand
}

function booleanOption(value, field, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new TypeError(`${name}: ${field} must be a boolean`)
  return value
}

export function apply(ctx, config) {
  const source = config === undefined ? {} : config
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new TypeError(`${name}: config must be an object`)
  }
  const unknown = Object.keys(source).filter((key) => !ALLOWED_KEYS.has(key))
  if (unknown.length > 0) {
    throw new TypeError(`${name}: unknown config key(s) ${unknown.join(', ')} — allowed: ${[...ALLOWED_KEYS].sort().join(', ')}`)
  }

  const defaultBand = source.defaultBand === undefined ? 'auto' : source.defaultBand
  if (defaultBand !== 'auto' && !BANDS.includes(defaultBand)) {
    throw new TypeError(`${name}: defaultBand must be "auto" or one of ${BANDS.join('/')}; got ${JSON.stringify(defaultBand)}`)
  }
  const includeSubagents = booleanOption(source.includeSubagents, 'includeSubagents', false)
  const budgetPrompt = booleanOption(source.budgetPrompt, 'budgetPrompt', true)

  runtime.ctx = ctx
  runtime.last = { defaultBand }

  /** agentCtx → { presentation, disposer }：一个会话一份呈现声明。 */
  const appliedByCtx = new WeakMap()

  let warned = false
  const warnOnce = (message) => {
    if (warned) return
    warned = true
    try {
      ctx.logger?.warn(message)
    } catch {
      // 日志不可用时忽略：这条只是避免刷屏。
    }
  }

  function currentBand(agent) {
    const resolved = resolveEffort(agent, ctx)
    if (resolved.effort !== undefined && !isKnownEffort(resolved.effort)) {
      warnOnce(`${name}: unknown reasoning effort ${JSON.stringify(resolved.effort)} → conservative band "low"`)
    }
    return bandOf(resolved.effort, fallbackBand(defaultBand))
  }

  function releasePresentation(agentCtx) {
    const entry = appliedByCtx.get(agentCtx)
    if (entry === undefined) return
    try {
      entry.disposer?.()
    } catch {
      // disposer 已被作用域回收：忽略。
    }
    appliedByCtx.delete(agentCtx)
  }

  function alignPresentation(agentCtx, target) {
    const entry = appliedByCtx.get(agentCtx)
    if (entry?.presentation === target) return
    // 同一 scope 只能声明一次：先撤销旧声明，再声明新档位。
    releasePresentation(agentCtx)
    // native 是部署默认值（tools 行没设 mode），不需要额外声明；
    // 这样 low 档与 v3.1.0 完全一致，不产生任何呈现调用。
    if (target === 'native') return
    try {
      const disposer = agentCtx.tools.presentAs(target)
      appliedByCtx.set(agentCtx, { presentation: target, disposer })
    } catch (error) {
      // PTC 运行时缺失或 scope 不合法：撤销后就是 native，会话照常继续。
      const message = String((error && error.message) || error)
      warnOnce(`${name}: presentation "${target}" unavailable, staying on native: ${message}`)
    }
  }

  /** 一轮开始前把呈现与解锁对齐到当前档位；轮内不再改动。 */
  function align(agent) {
    if (agent?.ctx === undefined) return
    if (!includeSubagents && (agent.session?.header?.delegationDepth ?? 0) > 0) return
    const band = currentBand(agent)
    const behavior = BAND_BEHAVIOR[band]
    try {
      setGateMode(behavior.unlock, { session: agent.session })
    } catch (error) {
      warnOnce(`${name}: gate mode switch failed: ${String((error && error.message) || error)}`)
    }
    alignPresentation(agent.ctx, behavior.presentation)
  }

  // 每轮 prompt 组装时对齐一次（轮内不再改动）：这里能拿到 agent（因此能拿
  // agent.ctx 与 session），而且对齐发生在 next() 之前，PTC 说明段当轮就绪。
  // 注意 `agent/pre-step` 的 payload 里没有 agent（引擎通过派发 carrier 传），
  // 所以不能挂在那里。
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    try {
      align(context?.agent)
    } catch (error) {
      warnOnce(`${name}: effort alignment failed: ${String((error && error.message) || error)}`)
    }
    return next()
  })

  // 档位状态段：紧跟环境段的 [MODEL] 之后（order 11），每轮按真实 effort 渲染。
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'whale-maid:effort',
    order: 11,
    text: ({ agent }) => {
      if (agent === undefined) return ''
      const band = currentBand(agent)
      const lines = [bandLine(band)]
      const guidance = bandGuidance(band, { budgetPrompt })
      if (guidance !== '') lines.push(guidance)
      return lines.join('\n')
    },
  }))
}
