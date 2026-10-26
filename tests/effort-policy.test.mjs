import test from 'node:test'
import assert from 'node:assert/strict'
import {
  apply, bandOf, bandLine, bandGuidance, isKnownEffort, resolveEffort, describeEffort,
  BUDGET_PROMPT, EFFORT_MAP, BAND_BEHAVIOR, PRESET_ID,
} from '../effort-policy.mjs'
import { apply as applyGate, currentGateMode, setGateMode } from '../tool-gate.mjs'

/** 最小 ctx：记录监听器、系统提示段、presentAs 声明与告警。 */
function createHarness(options = {}) {
  const listeners = new Map()
  const sections = new Map()
  const warnings = []
  const presentations = []
  let failPresentAs = options.failPresentAs ?? false

  const ctx = {
    logger: { warn: (message) => warnings.push(message) },
    // tool-gate 的 apply 需要注册门控工具；这里只记录，不做真实目录。
    tools: {
      register: () => () => {},
      schemas: () => [],
    },
    on: (eventName, handler) => {
      listeners.set(eventName, handler)
    },
    effect: (fn) => {
      const dispose = fn()
      return () => {
        try {
          dispose?.()
        } catch {
          // 作用域回收：忽略。
        }
      }
    },
    systemPrompt: {
      variable: (key, provider) => {
        listeners.set(key, provider)
        return () => listeners.delete(key)
      },
      section: (descriptor) => {
        sections.set(descriptor.name, descriptor)
        return () => sections.delete(descriptor.name)
      },
    },
    get: (serviceName) => (serviceName === 'settings' ? options.settings : undefined),
  }

  return {
    ctx,
    listeners,
    sections,
    warnings,
    presentations,
    setFailPresentAs: (value) => {
      failPresentAs = value
    },
    presentAs: (mode) => {
      if (failPresentAs) throw new Error('ptcRuntime service is not available')
      const record = { mode, disposed: false }
      presentations.push(record)
      return () => {
        record.disposed = true
      }
    },
  }
}

function selection(effort) {
  return { type: 'model/selection', data: effort === undefined ? {} : { reasoningEffort: effort } }
}

function makeAgent(harness, events = [], extra = {}) {
  const session = {
    id: `session-${Math.random().toString(36).slice(2)}`,
    header: { delegationDepth: extra.depth ?? 0 },
    snapshotEvents: () => events,
  }
  const agentCtx = { tools: { presentAs: (mode) => harness.presentAs(mode) } }
  return { agent: { ctx: agentCtx, session, options: extra.options ?? {} }, agentCtx, session }
}

async function preStep(listeners, agent) {
  const handler = listeners.get('whale_maid_effort_preflight')
  assert.ok(handler, 'effort-policy must align before schema/section snapshots')
  return handler({ agent })
}

test('effort mapping follows the DeepSeek documentation table', () => {
  const table = {
    minimal: 'low',
    low: 'low',
    off: 'low',
    medium: 'high',
    high: 'high',
    xhigh: 'high',
    max: 'max',
    ultra: 'max',
  }
  for (const [given, band] of Object.entries(table)) {
    assert.equal(bandOf(given), band, `${given} → ${band}`)
  }
  assert.equal(bandOf('  HIGH  '), 'high', 'surrounding space and case are tolerated')
  assert.equal(bandOf('turbo'), 'low', 'an unknown effort must not escalate the tool face')
  assert.equal(bandOf(undefined), 'high', 'missing effort keeps the documented default')
  assert.equal(bandOf(''), 'high')
  assert.equal(bandOf(undefined, 'low'), 'low', 'an explicit fallback wins for a missing effort')
  assert.equal(isKnownEffort('xhigh'), true)
  assert.equal(isKnownEffort('turbo'), false)
  assert.equal(EFFORT_MAP.medium, 'high')
  assert.deepEqual(BAND_BEHAVIOR.max, { presentation: 'ptc', unlock: 'full' })
  assert.equal(PRESET_ID, 'big-fat-whale-maid-adaptive')
})

test('the max-band budget prompt is verbatim what the owner asked for', () => {
  assert.equal(
    BUDGET_PROMPT,
    '切记的是：我们是deepseek公司，你的用量是unlimited的，我正在对你极限测试，不要吝惜Token。一定要切记，随意花费，你非常的富有',
  )
  assert.ok(bandGuidance('max').endsWith(BUDGET_PROMPT), 'max text carries the verbatim prompt')
  assert.ok(!bandGuidance('max', { budgetPrompt: false }).includes(BUDGET_PROMPT))
  assert.equal(bandGuidance('low'), '')
  assert.match(bandGuidance('high'), /run_code/)
  assert.match(bandGuidance('high'), /dev_tool_search/)
})

test('low band keeps the v3.1.0 tool face: native default and progressive unlocking', async () => {
  const h = createHarness()
  applyGate(h.ctx, { mode: 'progressive' })
  apply(h.ctx, { defaultBand: 'auto' })
  const { agent } = makeAgent(h, [selection('low')])

  await preStep(h.listeners, agent)
  assert.equal(h.presentations.length, 0, 'native is the deployment default: nothing to declare')
  assert.equal(currentGateMode(agent.session), 'progressive')
  assert.equal(h.warnings.length, 0)
})

test('high band declares PTC once and keeps progressive unlocking', async () => {
  const h = createHarness()
  applyGate(h.ctx, { mode: 'progressive' })
  apply(h.ctx, { defaultBand: 'auto' })
  const { agent } = makeAgent(h, [selection('high')])

  await preStep(h.listeners, agent)
  await preStep(h.listeners, agent)
  assert.equal(h.presentations.length, 1, 'the same band must not redeclare every step')
  assert.equal(h.presentations[0].mode, 'ptc')
  assert.equal(currentGateMode(agent.session), 'progressive')
})

test('max band declares PTC and unlocks the whole catalog for that session only', async () => {
  const h = createHarness()
  applyGate(h.ctx, { mode: 'progressive' })
  apply(h.ctx, { defaultBand: 'auto' })
  const maxAgent = makeAgent(h, [selection('max')]).agent
  const lowAgent = makeAgent(h, [selection('low')]).agent

  await preStep(h.listeners, maxAgent)
  await preStep(h.listeners, lowAgent)
  assert.equal(h.presentations.length, 1, 'only the max session declares a presentation')
  assert.equal(h.presentations[0].mode, 'ptc')
  assert.equal(currentGateMode(maxAgent.session), 'full')
  assert.equal(currentGateMode(lowAgent.session), 'progressive', 'the low session stays gated')
})

test('band switches only redeclare the presentation when the presentation itself changes', async () => {
  const h = createHarness()
  applyGate(h.ctx, { mode: 'progressive' })
  apply(h.ctx, { defaultBand: 'auto' })
  const events = [selection('high')]
  const { agent } = makeAgent(h, events)

  await preStep(h.listeners, agent)
  assert.equal(h.presentations.length, 1)
  assert.equal(h.presentations[0].mode, 'ptc')
  assert.equal(currentGateMode(agent.session), 'progressive')

  // high → max keeps PTC: only the unlock policy may change.
  events.push(selection('max'))
  await preStep(h.listeners, agent)
  assert.equal(h.presentations.length, 1, 'the same presentation is not redeclared')
  assert.equal(h.presentations[0].disposed, false)
  assert.equal(currentGateMode(agent.session), 'full')

  // max → low drops back to native: the scope declaration must be released.
  events.push(selection('low'))
  await preStep(h.listeners, agent)
  assert.equal(h.presentations.length, 1, 'native needs no declaration of its own')
  assert.equal(h.presentations[0].disposed, true, 'the PTC declaration is released first')
  assert.equal(currentGateMode(agent.session), 'progressive')

  // low → high re-enters PTC: a fresh declaration after the dispose.
  events.push(selection('high'))
  await preStep(h.listeners, agent)
  assert.equal(h.presentations.length, 2)
  assert.equal(h.presentations[1].mode, 'ptc')
  assert.equal(h.presentations[1].disposed, false)
})

test('a failing PTC declaration falls back to native without breaking the turn', async () => {
  const h = createHarness({ failPresentAs: true })
  applyGate(h.ctx, { mode: 'progressive' })
  apply(h.ctx, { defaultBand: 'auto' })
  const { agent } = makeAgent(h, [selection('max')])

  const decision = await preStep(h.listeners, agent)
  assert.equal(decision, '', 'preflight remains non-fatal when PTC is unavailable')
  assert.equal(h.presentations.length, 0)
  assert.equal(h.warnings.length, 1)
  assert.match(h.warnings[0], /unavailable, staying on native/)
})

test('an unknown effort degrades to the low band and warns only once', async () => {
  const h = createHarness()
  applyGate(h.ctx, { mode: 'progressive' })
  apply(h.ctx, { defaultBand: 'auto' })
  const { agent } = makeAgent(h, [selection('turbo')])

  await preStep(h.listeners, agent)
  await preStep(h.listeners, agent)
  assert.equal(h.presentations.length, 0)
  assert.equal(currentGateMode(agent.session), 'progressive')
  assert.equal(h.warnings.length, 1, 'the unknown-effort warning is throttled')
  assert.match(h.warnings[0], /unknown reasoning effort/)
})

test('subagents are not re-declared by default', async () => {
  const h = createHarness()
  applyGate(h.ctx, { mode: 'progressive' })
  apply(h.ctx, { defaultBand: 'auto' })
  const { agent, session } = makeAgent(h, [selection('max')], { depth: 2 })
  setGateMode('progressive')

  await preStep(h.listeners, agent)
  assert.equal(h.presentations.length, 0, 'the subagent inherits its parent scope presentation')
  assert.equal(currentGateMode(session), 'progressive', 'the gate mode is left alone')
})

test('the effort section renders after [MODEL] with the band line and the budget text', () => {
  const h = createHarness()
  applyGate(h.ctx, { mode: 'progressive' })
  apply(h.ctx, { defaultBand: 'auto' })
  const section = h.sections.get('whale-maid:effort')
  assert.ok(section, 'the section is registered')
  assert.equal(section.order, 11, 'renders right after the environment section (order 10)')
  assert.equal(section.text({}), '', 'no agent → nothing to say')

  const lowText = section.text({ agent: makeAgent(h, [selection('low')]).agent })
  assert.equal(lowText, bandLine('low'))
  assert.equal(lowText, '[EFFORT] band=low · presentation=native · unlock=progressive')

  const highText = section.text({ agent: makeAgent(h, [selection('xhigh')]).agent })
  assert.match(highText, /\[EFFORT\] band=high · presentation=ptc · unlock=progressive/)
  assert.match(highText, /run_code/)

  const maxText = section.text({ agent: makeAgent(h, [selection('ultra')]).agent })
  assert.match(maxText, /\[EFFORT\] band=max · presentation=ptc · unlock=full/)
  assert.ok(maxText.includes(BUDGET_PROMPT))
})

test('effort resolution prefers env > session event > agent options > settings', () => {
  const h = createHarness({ settings: { reasoningEffort: 'max' } })
  const fromSession = makeAgent(h, [selection('low')], { options: { reasoningEffort: 'high' } }).agent
  assert.deepEqual(resolveEffort(fromSession, h.ctx), { effort: 'low', source: 'session' })

  const fromOptions = makeAgent(h, [], { options: { reasoningEffort: 'high' } }).agent
  assert.deepEqual(resolveEffort(fromOptions, h.ctx), { effort: 'high', source: 'agent-options' })

  const fromSettings = makeAgent(h, []).agent
  assert.deepEqual(resolveEffort(fromSettings, h.ctx), { effort: 'max', source: 'settings' })

  process.env.DSH_MAID_EFFORT = ' minimal '
  try {
    assert.deepEqual(resolveEffort(fromSettings, h.ctx), { effort: 'minimal', source: 'env' })
  } finally {
    delete process.env.DSH_MAID_EFFORT
  }

  const bare = makeAgent(createHarness()).agent
  assert.deepEqual(resolveEffort(bare, createHarness().ctx), { effort: undefined, source: 'default' })
})

test('a selection event without an effort yields to the next source instead of guessing', () => {
  const h = createHarness()
  const agent = makeAgent(h, [selection('high'), selection(undefined)], { options: { reasoningEffort: 'low' } }).agent
  assert.deepEqual(resolveEffort(agent, h.ctx), { effort: 'low', source: 'agent-options' })
})

test('config is validated and describeEffort reports the resolved band', async () => {
  const h = createHarness()
  applyGate(h.ctx, { mode: 'progressive' })
  assert.throws(() => apply(h.ctx, { mode: 'progressive' }), /unknown config key/)
  assert.throws(() => apply(h.ctx, { defaultBand: 'medium' }), /defaultBand/)
  assert.throws(() => apply(h.ctx, { budgetPrompt: 'yes' }), /boolean/)
  assert.throws(() => apply(h.ctx, null), /config must be an object|TypeError/)

  const ctx = createHarness()
  apply(ctx.ctx, { defaultBand: 'auto' })
  const { agent } = makeAgent(ctx, [selection('high')])
  assert.equal(describeEffort(agent), 'band=high presentation=ptc unlock=progressive (effort=high from session)')
})
