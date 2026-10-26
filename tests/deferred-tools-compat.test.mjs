import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { ANCHOR_NAME, withDeferredToolAnchor, installAdapterGuard } from '../deferred-tools-compat.mjs'

const schema = (name, deferred = false) => ({ name, description: name, parameters: { type: 'object', properties: {} }, ...(deferred ? { deferLoading: true } : {}) })
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}

test('all-deferred projection adds one immediate anchor without touching the request or history', () => {
  const options = freeze({ tools: [schema('run_code', true)], messages: [{ role: 'developer', content: [{ type: 'tool-addition', toolName: 'run_code' }] }], toolHistory: { tools: [], updates: [] } })
  const before = JSON.stringify(options)
  const result = withDeferredToolAnchor(options)
  assert.notEqual(result, options)
  assert.equal(result.messages, options.messages)
  assert.equal(result.toolHistory, options.toolHistory)
  assert.equal(result.tools[0].name, ANCHOR_NAME)
  assert.equal(result.tools[0].deferLoading, undefined)
  assert.match(result.tools[0].description, /Never call/)
  assert.equal(result.tools[1], options.tools[0])
  assert.equal(result.tools[1].deferLoading, true)
  assert.equal(JSON.stringify(options), before)
  assert.equal(withDeferredToolAnchor(result), result, 'no duplicate anchor on retries')
})

for (const [label, tools] of [['missing', undefined], ['empty', []], ['native', [schema('read')]], ['mixed', [schema('read'), schema('run_code', true)]], ['fresh PTC', [schema('run_code')]]]) {
  test(`${label} tool list is an identity no-op`, () => {
    const input = freeze({ tools, messages: [] })
    assert.equal(withDeferredToolAnchor(input), input)
  })
}

test('all-deferred non-PTC lists also satisfy the transport invariant', () => {
  const input = freeze({ tools: [schema('office_open', true), schema('office_read', true)] })
  const result = withDeferredToolAnchor(input)
  assert.equal(result.tools.length, 3)
  assert.deepEqual(result.tools.slice(1), input.tools)
})

test('anchor name cannot shadow a real deferred tool', () => {
  const result = withDeferredToolAnchor({ tools: [schema(ANCHOR_NAME, true), schema(`${ANCHOR_NAME}_1`, true)] })
  assert.equal(result.tools[0].name, `${ANCHOR_NAME}_2`)
  assert.equal(new Set(result.tools.map(t => t.name)).size, 3)
})

test('public adapter guard preserves prepared generation, direct this/arguments, errors and disposal', async () => {
  const requests = []
  class Adapter {
    generation = 1
    async prepareCall(...args) {
      const generation = this.generation
      return { model: { id: 'test', generation, args }, stream: options => { requests.push({ options, generation }); return [generation] } }
    }
    stream(options, extra) { requests.push({ options, self: this, extra }); return [this.generation] }
  }
  const originalPrepare = Adapter.prototype.prepareCall
  const originalStream = Adapter.prototype.stream
  const dispose1 = installAdapterGuard(Adapter)
  const dispose2 = installAdapterGuard(Adapter)
  const adapter = new Adapter()
  const signal = new AbortController().signal
  const call = await adapter.prepareCall('provider', 'model', signal)
  adapter.generation = 2
  const options = freeze({ tools: [schema('run_code', true)], signal })
  assert.deepEqual(call.model.args, ['provider', 'model', signal])
  assert.deepEqual(call.stream(options), [1])
  assert.equal(requests.at(-1).options.signal, signal)
  assert.equal(requests.at(-1).options.tools.length, 2)
  assert.deepEqual(adapter.stream(options, 'extra'), [2])
  assert.equal(requests.at(-1).self, adapter)
  assert.equal(requests.at(-1).extra, 'extra')
  dispose1(); dispose1()
  assert.notEqual(Adapter.prototype.prepareCall, originalPrepare)
  dispose2()
  assert.equal(Adapter.prototype.prepareCall, originalPrepare)
  assert.equal(Adapter.prototype.stream, originalStream)
  const dispose3 = installAdapterGuard(Adapter)
  dispose3()
  assert.equal(Adapter.prototype.prepareCall, originalPrepare)
  class Failing {
    async prepareCall() { throw new Error('auth rejected') }
    stream() { throw new Error('cancelled') }
  }
  const disposeFailure = installAdapterGuard(Failing)
  try {
    await assert.rejects(new Failing().prepareCall(), /auth rejected/)
    assert.throws(() => new Failing().stream(options), /cancelled/)
  } finally { disposeFailure() }
  assert.throws(() => installAdapterGuard(class {}), /lacks prepareCall/)
})

const anchor = process.env.DSH_TEST_ANCHOR

test('bundle mounts the transport guard at profile scope, not inside one preset', { skip: !anchor }, () => {
  const require = createRequire(resolve(anchor, 'package.json'))
  const YAML = require('js-yaml')
  const js = new YAML.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => value })
  const bundle = YAML.load(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), { schema: YAML.JSON_SCHEMA.extend(js) })
  const rows = bundle[0].insert
  assert.equal(rows.filter(row => row.id === 'whale-maid-deferred-tools-compat').length, 1)
  assert.equal(rows[0].config.plugins.some(row => row.id === 'whale-maid-deferred-tools-compat'), false)
})

test('real DSH prepared pipeline and DeepSeek serializer: failing switch, patched switch, resume, reverse, fresh PTC, other provider', { skip: !anchor }, async t => {
  const require = createRequire(resolve(anchor, 'package.json'))
  const load = name => import(pathToFileURL(require.resolve(name)).href)
  const { Context } = await load('@deepseek-ai/cordis')
  const { LlmRuntime, LlmAdapter } = await load('@deepseek-ai/dsh-llm')
  let deepseek
  try { deepseek = await load('@deepseek-ai/dsh-llm-deepseek') } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND' && error.code !== 'ERR_MODULE_NOT_FOUND') throw error
    t.skip('engine predates DeepSeek Messages'); return
  }
  const { DeepSeekAdapter, resolveAdapterOptions } = deepseek
  const root = new Context()
  const llm = new LlmRuntime(root)
  let connection = resolveAdapterOptions({ baseURL: 'https://ptc-test.invalid', thinking: 'disabled', models: [{ id: 'test', toolUpdate: 'addition-only' }] })
  const { DeepSeekLlmApiExtensionRegistry } = await load('@deepseek-ai/dsh-deepseek-llm-api-extensions')
  const extensions = new DeepSeekLlmApiExtensionRegistry(root)
  const adapter = new DeepSeekAdapter({ options: () => connection, resolveAuth: async () => ({ headers: { authorization: 'Bearer test-only-not-a-key' } }), resolveUserId: () => 'ptc-test', prepareExtensions: request => extensions.prepare(request) })
  const unregister = llm.registerAdapter(['test-deepseek'], adapter)
  const native = schema('read')
  const ptc = schema('run_code')
  const messages = freeze([{ id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'test' }] }, { id: 'switch', role: 'developer', content: [{ type: 'tool-removal', toolName: 'read' }, { type: 'tool-addition', toolName: 'run_code' }] }])
  const history = freeze({ tools: [native], updates: [{ messageId: 'switch', additions: [ptc], removals: ['read'] }] })
  const base = { provider: 'test-deepseek', model: 'test', reasoningEffort: 'off' }
  const options = freeze({ ...base, messages, tools: [ptc], toolHistory: history })
  const before = JSON.stringify(options)
  const wire = []
  const originalFetch = globalThis.fetch
  const response = () => new Response([
    { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'test', content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  globalThis.fetch = async (url, request) => {
    assert.equal(String(url), 'https://ptc-test.invalid/v1/messages', 'no external network allowed')
    const body = JSON.parse(request.body)
    wire.push(body)
    if (body.tools?.length && body.tools.every(tool => tool.defer_loading === true)) {
      return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'tools: at least one tool must have defer_loading=false. All tools cannot be deferred.' } }), { status: 400 })
    }
    return response()
  }
  let dispose
  const collect = async input => {
    const call = await llm.prepareCall(base)
    return Array.fromAsync(call.stream(freeze({ ...input, ...call.config })))
  }
  const assertOk = chunks => assert.equal(chunks.at(-1)?.reason?.kind, 'stop', JSON.stringify(chunks))
  try {
    await t.test('unpatched reproduces exact all-deferred error at actual wire boundary', async () => {
      const chunks = await collect(options)
      assert.equal(chunks.at(-1)?.reason?.kind, 'error')
      assert.match(JSON.stringify(chunks), /All tools cannot be deferred/)
      assert.equal(wire.at(-1).tools[0].name, 'run_code')
    })
    dispose = installAdapterGuard(DeepSeekAdapter)
    await t.test('patched prepared dispatch succeeds; deferred order and original frozen history unchanged', async () => {
      assertOk(await collect(options))
      const body = wire.at(-1)
      assert.equal(body.tools.length, 2)
      assert.equal(body.tools[0].name, ANCHOR_NAME)
      assert.equal(body.tools[0].defer_loading, undefined)
      assert.equal(body.tools[1].name, 'run_code')
      assert.equal(body.tools[1].defer_loading, true)
      assert.equal(body.tools.some(tool => tool.name === 'read'), false)
      assert.ok(body.messages.some(message => message.content.some(block => block.type === 'tool_addition')))
      assert.equal(JSON.stringify(options), before)
    })
    await t.test('cold/reconstructed tool history gets the same wire request without accumulating anchors', async () => {
      const expected = wire.at(-1)
      assertOk(await collect(freeze(JSON.parse(JSON.stringify(options)))))
      assert.deepEqual(wire.at(-1), expected)
    })
    await t.test('reverse PTC -> native retains an immediate real native tool', async () => {
      const update = { id: 'reverse', role: 'developer', content: [{ type: 'tool-removal', toolName: 'run_code' }, { type: 'tool-addition', toolName: 'read' }] }
      const input = { ...base, messages: [...messages, update], tools: [native], toolHistory: { tools: [native], updates: [...history.updates, { messageId: 'reverse', additions: [native], removals: ['run_code'] }] } }
      assertOk(await collect(freeze(input)))
      assert.deepEqual(wire.at(-1).tools.map(tool => tool.name), ['read'])
    })
    await t.test('fresh PTC starts with immediate run_code and no anchor', async () => {
      assertOk(await collect(freeze({ ...base, messages: [messages[0]], tools: [ptc], toolHistory: { tools: [ptc], updates: [] } })))
      assert.deepEqual(wire.at(-1).tools.map(tool => tool.name), ['run_code'])
      assert.equal(wire.at(-1).tools[0].defer_loading, undefined)
    })
    await t.test('prepared connection snapshot and direct stream both remain supported', async () => {
      const prepared = await llm.prepareCall(base)
      const old = connection
      connection = { ...connection, baseURL: 'https://must-not-be-used.invalid' }
      try { assertOk(await Array.fromAsync(prepared.stream(freeze({ ...options, ...prepared.config })))) } finally { connection = old }
      assertOk(await Array.fromAsync(adapter.stream({ ...options, tools: [schema('run_code', true)] })))
      assert.equal(wire.at(-1).tools[0].name, ANCHOR_NAME)
    })
    await t.test('other adapters are not decorated', async () => {
      let received
      class Other extends LlmAdapter {
        providerInfo(id) { return { id, name: id } }
        async resolveModel(provider, id) { return { provider, id, name: id } }
        async *stream(input) { received = input; yield { type: 'finish', finish: { kind: 'stop' } } }
      }
      const off = llm.registerAdapter(['other'], new Other())
      try {
        const chunks = await Array.fromAsync(llm.stream({ provider: 'other', model: 'test', messages: [], tools: [ptc] }))
        assert.ok(received, JSON.stringify(chunks))
        assert.deepEqual(received.tools, [ptc])
      } finally { off() }
    })
  } finally { dispose?.(); unregister(); globalThis.fetch = originalFetch }
})
