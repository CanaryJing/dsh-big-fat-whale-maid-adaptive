import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, describeGate, GATE_TOOL, DEFAULT_RESIDENT_TOOLS } from '../tool-gate.mjs'

/** 构造最小 ctx + 一份工具目录，行为对齐 Cordis 服务形状。 */
function createHarness(catalogNames) {
  const tools = new Map()
  const listeners = new Map()
  const ctx = {
    logger: { warn: () => {} },
    tools: {
      register: (tool) => {
        tools.set(tool.name, tool)
        return () => {}
      },
      // 真实 DSH 里 schemas() 返回全量已注册目录（含别的插件注册的工具），
      // 本插件只注册 dev_tool_search，所以目录由 catalogNames 独立模拟。
      schemas: () => catalogNames.map((name) => ({
        name,
        description: name === GATE_TOOL ? (tools.get(GATE_TOOL)?.description ?? '') : `${name} description`,
      })),
    },
    on: (name, handler) => {
      listeners.set(name, handler)
    },
  }
  return { ctx, tools, listeners }
}

function assemble(listeners, agent, catalog) {
  const handler = listeners.get('system-prompt/assemble')
  assert.ok(handler, 'gate must register a system-prompt/assemble listener in progressive mode')
  return handler({}, { agent }, async () => ({ tools: catalog.map((name) => ({ name, description: name })), sections: [] }))
}

function makeSession(id, events = []) {
  return {
    id,
    header: { delegationDepth: 0 },
    snapshotEvents: () => events,
  }
}

test('progressive mode keeps only the resident core plus the gate tool', async () => {
  const { ctx, listeners } = createHarness(['gitbash', 'read', 'office_open', 'terminal_open', GATE_TOOL])
  apply(ctx, { mode: 'progressive' })
  const session = makeSession('gate-basic')
  const result = await assemble(listeners, { session }, ['gitbash', 'read', 'office_open', 'terminal_open', GATE_TOOL])
  const visible = result.tools.map((tool) => tool.name)
  assert.deepEqual(visible.sort(), [GATE_TOOL, 'gitbash', 'read'].sort())
  assert.ok(!visible.includes('office_open'), 'locked tools must not reach the request')
})

test('unlock takes effect on the next assembly for the same session', async () => {
  const { ctx, tools, listeners } = createHarness(['gitbash', 'office_open', GATE_TOOL])
  apply(ctx, { mode: 'progressive' })
  const session = makeSession('gate-unlock')
  const agent = { session }

  const gate = tools.get(GATE_TOOL)
  const unlock = await gate.execute({ toolNames: ['office_open'] }, { agent })
  assert.match(unlock.text, /已解锁/)

  const visible = (await assemble(listeners, agent, ['gitbash', 'office_open', GATE_TOOL])).tools.map((tool) => tool.name)
  assert.ok(visible.includes('office_open'), 'unlocked tool becomes visible')
})

test('resume rebuilds unlocks from the durable session log', async () => {
  const { ctx, listeners } = createHarness(['read', 'office_write', GATE_TOOL])
  apply(ctx, { mode: 'progressive' })
  const session = makeSession('gate-resume', [
    { type: 'tool/call', seq: 1, data: { name: GATE_TOOL, arguments: JSON.stringify({ toolNames: ['office_write'] }) } },
  ])
  const visible = (await assemble(listeners, { session }, ['read', 'office_write', GATE_TOOL])).tools.map((tool) => tool.name)
  assert.ok(visible.includes('office_write'), 'durable unlock survives a cold session scan')
})

test('mode: full exposes the whole catalog without registration side effects', async () => {
  const { ctx, listeners } = createHarness(['gitbash', 'office_open', GATE_TOOL])
  apply(ctx, { mode: 'full' })
  assert.equal(listeners.get('system-prompt/assemble'), undefined, 'full mode installs no assemble filter')
  assert.match(describeGate(undefined), /full/)
})

test('missing gate tool degrades to the full catalog instead of bricking the session', async () => {
  const { ctx, listeners } = createHarness(['gitbash'])
  apply(ctx, { mode: 'progressive' })
  const result = await assemble(listeners, { session: makeSession('gate-missing') }, ['gitbash', 'office_open'])
  assert.deepEqual(result.tools.map((tool) => tool.name), ['gitbash', 'office_open'])
})

test('subagents are not gated by default', async () => {
  const { ctx, listeners } = createHarness(['gitbash', 'office_open', GATE_TOOL])
  apply(ctx, { mode: 'progressive' })
  const session = { id: 'gate-sub', header: { delegationDepth: 1 }, snapshotEvents: () => [] }
  const result = await assemble(listeners, { session }, ['gitbash', 'office_open', GATE_TOOL])
  assert.equal(result.tools.length, 3)
})

test('unknown config keys are rejected', () => {
  const { ctx } = createHarness([GATE_TOOL])
  assert.throws(() => apply(ctx, { mode: 'progressive', residentTool: ['read'] }), /unknown config key/)
})

test('the gate tool searches the full catalog and reports unknown names', async () => {
  const { ctx, tools } = createHarness(['gitbash', 'office_open', GATE_TOOL])
  apply(ctx, { mode: 'progressive' })
  const agent = { session: makeSession('gate-search') }
  const gate = tools.get(GATE_TOOL)

  const found = await gate.execute({ query: 'office' }, { agent })
  assert.match(found.text, /office_open/)
  assert.match(found.text, /未解锁/)

  const missing = await gate.execute({ toolNames: ['nope_tool'] }, { agent })
  assert.match(missing.text, /未找到：nope_tool/)

  const overview = await gate.execute({}, { agent })
  assert.match(overview.text, /门控模式：progressive/)
  assert.match(overview.text, /常驻：/)
})

test('default resident core covers the measured high-frequency tools', () => {
  assert.ok(DEFAULT_RESIDENT_TOOLS.includes('gitbash'))
  assert.ok(DEFAULT_RESIDENT_TOOLS.includes('read'))
  assert.ok(DEFAULT_RESIDENT_TOOLS.includes('write'))
  assert.ok(DEFAULT_RESIDENT_TOOLS.includes('edit'))
  assert.ok(DEFAULT_RESIDENT_TOOLS.includes('skill_search'))
  assert.ok(DEFAULT_RESIDENT_TOOLS.length <= 32, 'resident core must stay small to keep the saving real')
})
