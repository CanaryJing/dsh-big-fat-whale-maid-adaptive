import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { apply as applyGate, GATE_TOOL } from '../tool-gate.mjs'

const anchor = process.env.DSH_TEST_ANCHOR

async function loadEngine() {
  const require = createRequire(resolve(anchor, 'package.json'))
  const load = (name) => import(pathToFileURL(require.resolve(name)).href)
  const { Context } = await load('@deepseek-ai/cordis')
  const { SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
  const { ToolRuntime } = await load('@deepseek-ai/dsh-tools')
  return { Context, SystemPrompt, ToolRuntime }
}

const officeTool = {
  name: 'office_open',
  description: 'open an office document',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  output: {
    schema: { type: 'object', properties: {}, additionalProperties: false },
    render: () => [{ type: 'text', text: 'opened' }],
  },
  async execute() { return {} },
}

function makeSession(events = []) {
  return { id: randomUUID(), header: { cwd: process.cwd() }, snapshotEvents: () => events }
}

function gateCall(callId, args = { toolNames: ['office_open'] }) {
  return {
    type: 'tool/call',
    seq: 1,
    data: { name: GATE_TOOL, callId, arguments: JSON.stringify(args) },
  }
}

function gateResult(callId, meta) {
  return {
    type: 'tool/result',
    seq: 2,
    data: {
      message: {
        toolCallId: callId,
        isError: false,
        content: [{ type: 'text', text: '已解锁（下一次请求起可见）：office_open' }],
      },
      ...(meta === undefined ? {} : { meta }),
    },
  }
}

async function visible(prompt, session) {
  const assembly = await prompt.assemble({ agent: { session } })
  return assembly.tools.map((tool) => tool.name)
}

test('real DSH Tools registry executes gate output meta and recovery pairs the callId', { skip: !anchor }, async () => {
  const { Context, SystemPrompt, ToolRuntime } = await loadEngine()
  const root = new Context()
  const prompt = new SystemPrompt(root, { includeHarnessIdentity: true })
  const tools = new ToolRuntime(root, {})
  tools.register(officeTool)
  applyGate(root, { mode: 'progressive', residentTools: ['read'] })

  assert.ok(tools.get(GATE_TOOL), 'gate tool must register in the real registry')
  assert.ok(tools.schemas().some((schema) => schema.name === GATE_TOOL))

  // 1) A real successful execution produces result.meta in the official shape.
  const liveSession = makeSession([])
  const liveAgent = { session: liveSession }
  assert.ok(!(await visible(prompt, liveSession)).includes('office_open'), 'office_open starts locked')
  const result = await tools.execute({
    callId: 'gate-live-call',
    name: GATE_TOOL,
    arguments: { toolNames: ['office_open'] },
    agent: liveAgent,
    signal: AbortSignal.timeout(5000),
  })
  assert.equal(result.isError, false)
  assert.deepEqual(result.meta, { gate: GATE_TOOL, accepted: ['office_open'] })
  assert.ok((await visible(prompt, liveSession)).includes('office_open'), 'successful execution is visible next assembly')

  // 2) Persisted call+result meta recovers in a fresh session only when paired.
  const recovered = makeSession([
    gateCall('recover-call'),
    gateResult('recover-call', result.meta),
  ])
  const recoveredVisible = await visible(prompt, recovered)
  assert.ok(recoveredVisible.includes('office_open'), 'paired meta must be recoverable')
  assert.ok(!recoveredVisible.includes('office_write'), 'only the exact accepted names come back')

  const forged = makeSession([
    gateResult('other-call', { gate: GATE_TOOL, accepted: ['office_open'] }),
  ])
  assert.ok(!(await visible(prompt, forged)).includes('office_open'),
    'meta on a result with no dev_tool_search call must not unlock')

  const interrupted = makeSession([gateCall('interrupted-call')])
  assert.ok(!(await visible(prompt, interrupted)).includes('office_open'),
    'a call with no result is indistinguishable from an interruption and stays locked')

  // 3) The fixed success text is also only trusted with a paired call.
  const textOnly = makeSession([gateResult('unpaired-text-call', undefined)])
  assert.ok(!(await visible(prompt, textOnly)).includes('office_open'),
    'unpaired success text must not unlock')
  const textPaired = makeSession([
    gateCall('paired-text-call'),
    gateResult('paired-text-call', undefined),
  ])
  assert.ok((await visible(prompt, textPaired)).includes('office_open'),
    'v3.0 fixed success text recovers when paired with its gate call')
})
