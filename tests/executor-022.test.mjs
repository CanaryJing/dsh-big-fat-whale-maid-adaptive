import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { apply as gateApply, GATE_TOOL } from '../tool-gate.mjs'
import * as effortPolicy from '../effort-policy.mjs'

const anchor = process.env.DSH_TEST_ANCHOR
const skip = !anchor && 'needs DSH_TEST_ANCHOR'
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const definition = name => ({
  name, description: name, parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'object', properties: {} }, render: () => [] },
  async execute() { return {} },
})
async function harness(initial, order = 'effort-first') {
  const require = createRequire(resolve(anchor, 'package.json'))
  const load = name => import(pathToFileURL(require.resolve(name)).href)
  const { Context } = await load('@deepseek-ai/cordis')
  const { SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
  const { ToolsService } = await load('@deepseek-ai/dsh-tools')
  const native = await load('@deepseek-ai/dsh-tool-executor-native')
  const { createScope } = await load('@deepseek-ai/dsh-scope')
  const root = new Context()
  const prompt = new SystemPrompt(root, { includeHarnessIdentity: false })
  const tools = new ToolsService(root, {})
  await root.plugin(native, {}).await()
  root.provide('workingDirectory', { ensure: async () => process.cwd() })
  root.provide('ptcRuntime', {
    language: 'typescript', programFormat: 'function-body',
    resolve: request => request,
    async run(request) {
      const value = await new AsyncFunction('tools', request.program)(request.bindings[0].functions)
      return { logs: [], value }
    },
    release() {},
  })
  const parent = {}
  const preset = createScope(root, parent)
  const events = []
  const session = { id: randomUUID(), header: { cwd: process.cwd() }, events,
    append(type, data) { const event = { type, data }; events.push(event); root.emit('session/event', session, event); return event },
  }
  const agent = { options: { reasoningEffort: initial }, session }
  const scope = createScope(root, agent, { parent })
  agent.ctx = scope.ctx
  for (const name of ['read', 'office_open', 'other_capability', 'ancestor_denied', 'conditional_off']) {
    preset.ctx.tools.register(definition(name), name === 'conditional_off' ? { when: () => false } : undefined)
  }
  const oldEntry = process.argv[1]
  process.argv[1] = resolve(anchor, 'lib/bin.js')
  try {
    const gate = () => gateApply(preset.ctx, { residentTools: ['read'] })
    if (order === 'effort-first') { await preset.ctx.plugin(effortPolicy, {}).await(); gate() }
    else { gate(); await preset.ctx.plugin(effortPolicy, {}).await() }
  } finally { process.argv[1] = oldEntry }
  scope.ctx.tools.restrict({ deny: ['ancestor_denied'] })
  const selections = []
  async function assemble(band, viewer = agent) {
    if (band) viewer.options.reasoningEffort = band
    const toolSet = await tools.resolve({ agent: viewer, modelSelection: {}, signal: AbortSignal.timeout(5000) })
    selections.push(toolSet)
    const assembly = await prompt.assemble({ scope: viewer, agent: viewer, toolSet })
    return { assembly, toolSet, sdk: assembly.sections.find(section => section.name === 'tools:sdk')?.text ?? '' }
  }
  let counter = 0
  const run = (step, code, name = 'run_code') => tools.execute({
    agent, toolSet: step.toolSet, signal: AbortSignal.timeout(5000),
    calls: [{ type: 'tool-call', id: `root-${++counter}`, name, arguments: JSON.stringify(name === 'run_code' ? { code, description: 'Verify executor gate behavior' } : {}) }],
  })
  return { root, tools, agent, preset, scope, assemble, run, createScope, parent,
    async close() { for (const selection of selections) selection.dispose(); await scope.dispose(); await preset.dispose() },
  }
}

for (const initial of ['low', 'high', 'max']) for (const order of ['effort-first', 'gate-first']) {
  test(`0.2.2 first ${initial}, current-step band changes and bindings (${order})`, { skip }, async () => {
    const h = await harness(initial, order)
    try {
      for (const band of [initial, 'max', 'high', 'low', 'high', 'max']) {
        const step = await h.assemble(band)
        const names = step.assembly.tools.map(tool => tool.name)
        assert.match(step.assembly.sections.find(s => s.name === 'whale-maid:effort').text, new RegExp('band=' + band))
        if (band === 'low') {
          assert.ok(names.includes('read') && names.includes(GATE_TOOL))
          assert.ok(!names.includes('run_code') && !names.includes('office_open'))
          assert.equal(step.sdk, '')
        } else {
          assert.deepEqual(names, ['run_code'])
          assert.ok(step.sdk.includes(GATE_TOOL))
          assert.equal(step.sdk.includes('office_open:'), band === 'max')
          assert.ok(!step.sdk.includes('ancestor_denied') && !step.sdk.includes('conditional_off'))
          const result = await h.run(step, 'return Object.keys(tools)')
          assert.equal(result.results[0].result.isError, false, JSON.stringify(result))
          const bindings = result.results[0].result.value.result
          assert.equal(bindings.includes('office_open'), band === 'max')
          assert.ok(!bindings.includes('ancestor_denied') && !bindings.includes('conditional_off'))
        }
      }
      const step = await h.assemble('high')
      const result = await h.run(step, 'await tools.dev_tool_search({toolNames:["office_open"]}); return typeof tools.office_open')
      assert.equal(result.results[0].result.isError, false, JSON.stringify(result))
      assert.equal(result.results[0].result.value.result, 'undefined', 'unlock cannot change current program bindings')
      const next = await h.assemble()
      assert.ok(next.sdk.includes('office_open:'), 'unlock must be available next step, not one step later')
      const called = await h.run(next, 'return await tools.office_open({})')
      assert.equal(called.results[0].result.isError, false, JSON.stringify(called))
      const direct = await h.run(next, '', 'office_open')
      assert.equal(direct.results[0].result.isError, true, 'PTC rejects direct capability calls')
      assert.ok(h.tools.schemas(h.agent).some(tool => tool.name === 'other_capability'), 'discovery registry remains complete')
    } finally { await h.close() }
  })
}

test('0.2.2 two agents in the same preset isolate effort, unlocks and recovery', { skip }, async () => {
  const h = await harness('high')
  const second = { options: { reasoningEffort: 'high' }, session: { id: randomUUID(), header: {}, events: [] } }
  const secondScope = h.createScope(h.root, second, { parent: h.parent })
  second.ctx = secondScope.ctx
  try {
    const first = await h.assemble('high')
    await h.run(first, 'await tools.dev_tool_search({toolNames:["office_open"]})')
    assert.ok((await h.assemble()).sdk.includes('office_open:'))
    assert.ok(!(await h.assemble('high', second)).sdk.includes('office_open:'))
    assert.ok((await h.assemble('max', second)).sdk.includes('other_capability:'))
    assert.ok(!(await h.assemble('high')).sdk.includes('other_capability:'))
    // Reconstruct only successful paired PTC events in a fresh session identity.
    second.session.events = structuredClone(h.agent.session.events)
    second.session.id = randomUUID()
    assert.ok((await h.assemble('high', second)).sdk.includes('office_open:'))
  } finally { await secondScope.dispose(); await h.close() }
})

test('0.2.2 removals, guards and conditional admission remain authoritative', { skip }, async () => {
  const h = await harness('max')
  try {
    const remove = h.preset.ctx.tools.register(definition('temporary_tool'))
    const step = await h.assemble()
    remove()
    const removed = await h.run(step, 'return typeof tools.temporary_tool')
    assert.equal(removed.results[0].result.value.result, 'undefined')
    h.scope.ctx.tools.guard(exec => exec.name === 'office_open' ? 'test permission denied' : undefined)
    const denied = await h.run(step, 'return await tools.office_open({})')
    assert.equal(denied.results[0].result.isError, true)
    assert.match(denied.results[0].result.error.message, /test permission denied/)
    assert.ok(!step.sdk.includes('conditional_off:'))
  } finally { await h.close() }
})
