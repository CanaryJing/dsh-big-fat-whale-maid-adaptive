import test from 'node:test'
import assert from 'node:assert/strict'
import {
  apply, describeGate, GATE_TOOL, DEFAULT_RESIDENT_TOOLS, TOOL_GROUPS,
} from '../tool-gate.mjs'

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

test('resume rebuilds unlocks from a successful paired session log', async () => {
  const { ctx, listeners } = createHarness(['read', 'office_write', GATE_TOOL])
  apply(ctx, { mode: 'progressive' })
  const session = makeSession('gate-resume', [
    callEvent('call-resume', { toolNames: ['office_write'] }),
    {
      type: 'tool/result',
      seq: 2,
      data: {
        message: {
          toolCallId: 'call-resume',
          isError: false,
          content: [{ type: 'text', text: '已解锁（下一次请求起可见）：office_write' }],
        },
      },
    },
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

// ── v3.1.0: groups, accepted persistence, recovery and scope ────────────────

function resultEvent(callId, accepted, { error = false } = {}) {
  return {
    type: 'tool/result',
    seq: 99,
    data: {
      message: { toolCallId: callId, isError: error },
      ...(error ? { error: { name: 'ToolError', code: 'FAILED' } } : {}),
      ...(accepted === undefined ? {} : { meta: { gate: GATE_TOOL, accepted } }),
    },
  }
}

function callEvent(callId, args) {
  return {
    type: 'tool/call',
    seq: 1,
    data: { name: GATE_TOOL, callId, arguments: JSON.stringify(args) },
  }
}

test('groups expand against the actual catalog and merge/dedupe with exact names', async () => {
  const catalog = ['read', 'office_open', 'office_write', 'terminal_open', GATE_TOOL]
  const { ctx, tools, listeners } = createHarness(catalog)
  apply(ctx, { mode: 'progressive' })
  const session = makeSession('gate-groups')
  const agent = { session }
  const gate = tools.get(GATE_TOOL)

  const result = await gate.execute({ groups: ['office'] }, { agent })
  assert.deepEqual(result.accepted, ['office_open', 'office_write'])
  const visible = (await assemble(listeners, agent, catalog)).tools.map((tool) => tool.name)
  assert.ok(visible.includes('office_open'))
  assert.ok(visible.includes('office_write'))
  assert.ok(!visible.includes('terminal_open'))

  const merged = await gate.execute({ groups: ['office'], toolNames: ['office_open', 'office_open'] }, { agent })
  assert.deepEqual(merged.accepted, ['office_open', 'office_write'], 'exact name + group expansion must dedupe')
})

test('partial missing names, unknown groups and empty groups do not abort valid work', async () => {
  const catalog = ['read', 'office_open', GATE_TOOL]
  const { ctx, tools } = createHarness(catalog)
  apply(ctx, { mode: 'progressive' })
  const agent = { session: makeSession('gate-partial') }
  const gate = tools.get(GATE_TOOL)

  const result = await gate.execute({
    groups: ['office', 'nope', 'terminal'],
    toolNames: ['office_open', 'missing_tool'],
  }, { agent })
  assert.deepEqual(result.accepted, ['office_open'])
  assert.match(result.text, /未找到：missing_tool/)
  assert.match(result.text, /未知组：nope/)
  assert.match(result.text, /其余合法项已继续处理/)
  assert.match(result.text, /组在当前目录没有可解锁工具：terminal/)
})

test('groups never unlock a tool outside the execution scope', async () => {
  const catalog = ['read', 'office_open', GATE_TOOL]
  const { ctx, tools, listeners } = createHarness(catalog)
  apply(ctx, { mode: 'progressive' })
  const agent = { session: makeSession('gate-scope') }
  const gate = tools.get(GATE_TOOL)

  const result = await gate.execute({ groups: ['office'], toolNames: ['office_write'] }, { agent })
  assert.deepEqual(result.accepted, ['office_open'])
  assert.match(result.text, /未找到：office_write/)
  const visible = (await assemble(listeners, agent, catalog)).tools.map((tool) => tool.name)
  assert.ok(!visible.includes('office_write'))
  assert.deepEqual(Object.keys(TOOL_GROUPS).sort(), ['memory-write', 'office', 'repo-files', 'sessions', 'team', 'terminal'].sort())
})

test('unlocks are isolated across sessions', async () => {
  const catalog = ['read', 'office_open', GATE_TOOL]
  const { ctx, tools, listeners } = createHarness(catalog)
  apply(ctx, { mode: 'progressive' })
  const first = { session: makeSession('gate-cross-a') }
  const second = { session: makeSession('gate-cross-b') }
  await tools.get(GATE_TOOL).execute({ groups: ['office'] }, { agent: first })

  assert.ok((await assemble(listeners, first, catalog)).tools.some((tool) => tool.name === 'office_open'))
  assert.ok(!(await assemble(listeners, second, catalog)).tools.some((tool) => tool.name === 'office_open'))
})

test('resume restores only the accepted names recorded in tool/result meta', async () => {
  const catalog = ['read', 'office_open', 'office_write', GATE_TOOL]
  const { ctx, listeners } = createHarness(catalog)
  apply(ctx, { mode: 'progressive' })
  const session = makeSession('gate-resume-new', [
    callEvent('call-1', { groups: ['office'], toolNames: ['office_write'] }),
    resultEvent('call-1', ['office_open']),
  ])
  const visible = (await assemble(listeners, { session }, catalog)).tools.map((tool) => tool.name)
  assert.ok(visible.includes('office_open'))
  assert.ok(!visible.includes('office_write'), 'requested-but-not-accepted and future group expansion must not be replayed')
})

test('empty accepted meta is authoritative on cold start and never falls back to success text', async () => {
  const catalog = ['read', 'office_open', GATE_TOOL]
  const { ctx, listeners } = createHarness(catalog)
  apply(ctx, { mode: 'progressive' })
  // 只做搜索时 accepted 为空；第三方工具描述里可能恰好含本工具的成功文案。
  const session = makeSession('gate-empty-cold', [
    callEvent('call-empty-cold', { query: 'office' }),
    {
      type: 'tool/result',
      seq: 2,
      data: {
        message: {
          toolCallId: 'call-empty-cold',
          isError: false,
          content: [{
            type: 'text',
            text: '匹配工具（1）：\n- office_open [未解锁]：第三方描述包含 已解锁（下一次请求起可见）：office_open',
          }],
        },
        meta: { gate: GATE_TOOL, accepted: [] },
      },
    },
  ])
  const visible = (await assemble(listeners, { session }, catalog)).tools.map((tool) => tool.name)
  assert.ok(!visible.includes('office_open'), 'an empty accepted meta must never replay unrelated success text')
})

test('empty accepted meta is authoritative on live incremental results too', async () => {
  const catalog = ['read', 'office_open', GATE_TOOL]
  const { ctx, listeners } = createHarness(catalog)
  apply(ctx, { mode: 'progressive' })
  const session = makeSession('gate-empty-live', [])
  await assemble(listeners, { session }, catalog) // initialize an empty entry
  listeners.get('session/event')(session, callEvent('call-empty-live', { query: 'office' }))
  listeners.get('session/event')(session, {
    type: 'tool/result',
    seq: 2,
    data: {
      message: {
        toolCallId: 'call-empty-live',
        isError: false,
        content: [{
          type: 'text',
          text: '匹配工具（1）：\n- office_open [未解锁]：第三方描述包含 已解锁（下一次请求起可见）：office_open',
        }],
      },
      meta: { gate: GATE_TOOL, accepted: [] },
    },
  })
  const visible = (await assemble(listeners, { session }, catalog)).tools.map((tool) => tool.name)
  assert.ok(!visible.includes('office_open'), 'live empty accepted meta must not unlock via unrelated success text')
})

test('a non-gate meta on a paired result never falls back to the legacy success text', async () => {
  const catalog = ['read', 'office_open', 'office_write', GATE_TOOL]
  const { ctx, listeners } = createHarness(catalog)
  apply(ctx, { mode: 'progressive' })
  const session = makeSession('gate-foreign-meta', [
    callEvent('call-foreign', { toolNames: ['office_open'] }),
    {
      type: 'tool/result',
      seq: 2,
      data: {
        message: {
          toolCallId: 'call-foreign',
          isError: false,
          content: [{ type: 'text', text: '已解锁（下一次请求起可见）：office_open' }],
        },
        meta: { gate: 'some_other_tool', accepted: ['office_write'] },
      },
    },
  ])
  const visible = (await assemble(listeners, { session }, catalog)).tools.map((tool) => tool.name)
  assert.ok(!visible.includes('office_open'), 'foreign meta must not trigger the v3.0 text fallback')
  assert.ok(!visible.includes('office_write'), 'foreign meta accepted names must not be trusted')
})

test('v3.0 successful calls need a paired result; a call-only interrupted call stays locked', async () => {
  const catalog = ['read', 'office_write', GATE_TOOL]
  const { ctx, listeners } = createHarness(catalog)
  apply(ctx, { mode: 'progressive' })

  const onlyCall = makeSession('gate-legacy-call', [
    callEvent('call-1', { toolNames: ['office_write'] }),
  ])
  assert.ok(!(await assemble(listeners, { session: onlyCall }, catalog)).tools.some((tool) => tool.name === 'office_write'),
    'a tool/call with no result cannot be distinguished from an interruption')

  const legacyResult = makeSession('gate-legacy-result', [
    callEvent('call-2', { toolNames: ['office_write'] }),
    {
      type: 'tool/result',
      seq: 2,
      data: {
        message: {
          toolCallId: 'call-2',
          isError: false,
          content: [{ type: 'text', text: '已解锁（下一次请求起可见）：office_write' }],
        },
      },
    },
  ])
  assert.ok((await assemble(listeners, { session: legacyResult }, catalog)).tools.some((tool) => tool.name === 'office_write'),
    'a v3.0 fixed success text paired with its call remains recoverable')
})

test('legacy result text restores the accepted names rather than every requested name', async () => {
  const catalog = ['read', 'office_open', 'office_write', GATE_TOOL]
  const { ctx, listeners } = createHarness(catalog)
  apply(ctx, { mode: 'progressive' })
  const session = makeSession('gate-legacy-text', [
    callEvent('call-text', { toolNames: ['office_open', 'office_write'] }),
    {
      type: 'tool/result',
      seq: 2,
      data: {
        message: {
          toolCallId: 'call-text',
          isError: false,
          content: [{ type: 'text', text: '已解锁（下一次请求起可见）：office_open' }],
        },
      },
    },
  ])
  const visible = (await assemble(listeners, { session }, catalog)).tools.map((tool) => tool.name)
  assert.ok(visible.includes('office_open'))
  assert.ok(!visible.includes('office_write'), 'legacy text is authoritative for actually accepted names')
})

test('failed tool/result calls are never restored as successful unlocks', async () => {
  const catalog = ['read', 'office_write', GATE_TOOL]
  const { ctx, listeners } = createHarness(catalog)
  apply(ctx, { mode: 'progressive' })

  for (const [id, meta] of [['gate-failed', undefined], ['gate-failed-meta', ['office_write']]]) {
    const session = makeSession(id, [
      callEvent('call-1', { toolNames: ['office_write'] }),
      resultEvent('call-1', meta, { error: true }),
    ])
    const visible = (await assemble(listeners, { session }, catalog)).tools.map((tool) => tool.name)
    assert.ok(!visible.includes('office_write'), id)
  }
})

test('live call+result meta unlocks the same session on the next assembly', async () => {
  const catalog = ['read', 'office_open', GATE_TOOL]
  const { ctx, listeners } = createHarness(catalog)
  apply(ctx, { mode: 'progressive' })
  const session = makeSession('gate-live', [])
  await assemble(listeners, { session }, catalog) // initialize an empty entry
  listeners.get('session/event')(session, callEvent('call-live', { toolNames: ['office_open'] }))
  listeners.get('session/event')(session, resultEvent('call-live', ['office_open']))
  assert.ok((await assemble(listeners, { session }, catalog)).tools.some((tool) => tool.name === 'office_open'))
})

test('unrelated tool text and forged gate meta never unlock without a paired gate call', async () => {
  const catalog = ['read', 'office_open', GATE_TOOL]
  const { ctx, listeners } = createHarness(catalog)
  apply(ctx, { mode: 'progressive' })

  const textOnly = makeSession('gate-unrelated-text', [
    {
      type: 'tool/result',
      seq: 2,
      data: {
        message: {
          toolCallId: 'other-call',
          isError: false,
          content: [{ type: 'text', text: '已解锁（下一次请求起可见）：office_open' }],
        },
      },
    },
  ])
  assert.ok(!(await assemble(listeners, { session: textOnly }, catalog)).tools.some((tool) => tool.name === 'office_open'))

  const forgedMeta = makeSession('gate-unrelated-meta', [
    {
      type: 'tool/result',
      seq: 3,
      data: {
        message: { toolCallId: 'other-call', isError: false },
        meta: { gate: GATE_TOOL, accepted: ['office_open'] },
      },
    },
  ])
  assert.ok(!(await assemble(listeners, { session: forgedMeta }, catalog)).tools.some((tool) => tool.name === 'office_open'))

  const liveForged = makeSession('gate-live-forged', [])
  await assemble(listeners, { session: liveForged }, catalog)
  listeners.get('session/event')(liveForged, callEvent('actual-gate-call', { toolNames: [] }))
  listeners.get('session/event')(liveForged, {
    type: 'tool/result',
    seq: 4,
    data: {
      message: { toolCallId: 'unrelated-call', isError: false },
      meta: { gate: GATE_TOOL, accepted: ['office_open'] },
    },
  })
  assert.ok(!(await assemble(listeners, { session: liveForged }, catalog)).tools.some((tool) => tool.name === 'office_open'))
})

test('a successful gate call without a result never unlocks on live recovery', async () => {
  const catalog = ['read', 'office_open', GATE_TOOL]
  const { ctx, listeners } = createHarness(catalog)
  apply(ctx, { mode: 'progressive' })
  const session = makeSession('gate-live-interrupted', [])
  await assemble(listeners, { session }, catalog)
  listeners.get('session/event')(session, callEvent('call-interrupted', { toolNames: ['office_open'] }))
  assert.ok(!(await assemble(listeners, { session }, catalog)).tools.some((tool) => tool.name === 'office_open'))
})

test('executing without a session returns accepted:[] and says nothing was unlocked', async () => {
  const catalog = ['read', 'office_open', GATE_TOOL]
  const { ctx, tools } = createHarness(catalog)
  apply(ctx, { mode: 'progressive' })
  const result = await tools.get(GATE_TOOL).execute({ toolNames: ['office_open'] }, {})
  assert.deepEqual(result.accepted, [])
  assert.doesNotMatch(result.text, /已解锁/)
  assert.match(result.text, /没有可持久化的会话/)
  assert.match(result.text, /accepted 为空/)
})

test('presentationMeta persists exact accepted names, never group names', () => {
  const { ctx, tools } = createHarness(['read', 'office_open', GATE_TOOL])
  apply(ctx, { mode: 'progressive' })
  const gate = tools.get(GATE_TOOL)
  assert.equal(typeof gate.output.presentationMeta, 'function')
  const meta = gate.output.presentationMeta({ groups: ['office'] }, { text: 'ok', accepted: ['office_open'] })
  assert.deepEqual(meta, { gate: GATE_TOOL, accepted: ['office_open'] })
})

test('no-argument overview lists fixed groups and purposes; search uses any-keyword scoring', async () => {
  const catalog = ['read', 'office_open', 'terminal_open', GATE_TOOL]
  const { ctx, tools } = createHarness(catalog)
  apply(ctx, { mode: 'progressive' })
  const agent = { session: makeSession('gate-overview') }
  const gate = tools.get(GATE_TOOL)

  const overview = await gate.execute({}, { agent })
  for (const group of ['office', 'repo-files', 'sessions', 'team', 'terminal', 'memory-write']) {
    assert.match(overview.text, new RegExp(`- ${group}：`))
  }

  const search = await gate.execute({ query: 'office terminal' }, { agent })
  assert.match(search.text, /office_open/)
  assert.match(search.text, /terminal_open/)
  assert.match(gate.description, /任一关键词命中/)
  assert.doesNotMatch(gate.description, /同时命中全部关键词/)
})
