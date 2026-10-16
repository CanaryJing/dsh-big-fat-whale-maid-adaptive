import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../instruction-hint.mjs'

const preset = 'big-fat-whale-maid-adaptive'
const ownKind = `plugin:${preset}:instruction-hint`
function setup() {
  let preStep
  const events = []
  apply({
    on(name, handler) { if (name === 'agent/pre-step') preStep = handler; events.push(name) },
    get: () => ({ resolve: async (target) => target, stat: async (target) => target.endsWith('AGENTS.md') ? { type: 'file' } : undefined }),
    logger: { warn: () => {} },
  }, { promoteOn: 'either', includeSubagents: true })
  return async (messages = []) => {
    const history = [{ type: 'tool/call', seq: 1 }, ...messages]
    const session = { id: 's1', header: { cwd: 'D:\\workspace' }, snapshotEvents: () => history }
    const result = await preStep({ agent: { session } }, async () => ({ kind: 'continue', messages: [] }))
    return result.messages
  }
}
const event = (id, source) => ({ type: 'user/message', seq: 2, data: { id, source } })

test('cold session receives one instruction hint with a dedicated producer kind', async () => {
  const drive = setup()
  const messages = await drive()
  assert.equal(messages.length, 1)
  assert.equal(messages[0].source.kind, ownKind)
  assert.match(messages[0].id, /^instruction-hint-s1-/)
  assert.deepEqual(await drive(), [])
})

for (const source of [
  { kind: ownKind },
  { kind: `plugin:${preset}` },
  { kind: 'plugin', plugin: preset },
  { kind: 'instruction-hint' },
]) {
  test(`restart recognizes previous hint: ${JSON.stringify(source)}`, async () => {
    assert.deepEqual(await setup()([event('instruction-hint-s1-old', source)]), [])
  })
}

for (const source of [
  { kind: `plugin:${preset}` },
  { kind: 'plugin', plugin: preset },
  { kind: 'plugin:other-plugin' },
]) {
  test(`environment brief does not suppress instruction hint: ${JSON.stringify(source)}`, async () => {
    const messages = await setup()([event('env-brief-s1', source)])
    assert.equal(messages.length, 1)
    assert.equal(messages[0].source.kind, ownKind)
  })
}
