import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as gate from '../tool-gate.mjs'

const anchor = process.env.DSH_TEST_ANCHOR

test('tool-gate mounts through real Cordis dependency guard and assembles a fresh session', { skip: !anchor }, async () => {
  const require = createRequire(resolve(anchor, 'package.json'))
  const load = name => import(pathToFileURL(require.resolve(name)).href)
  const { Context } = await load('@deepseek-ai/cordis')
  const { SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
  const { ToolRuntime } = await load('@deepseek-ai/dsh-tools')
  const root = new Context()
  // Providers MUST be separate fibers, as in the production loader. Direct
  // constructors on root leak root dependency access and hide missing injects.
  const promptProvider = root.plugin(SystemPrompt, { includeHarnessIdentity: false })
  const toolsProvider = root.plugin(ToolRuntime, {})
  await promptProvider.await()
  await toolsProvider.await()
  const prompt = root.get('systemPrompt')
  const tools = root.get('tools')
  const fiber = root.plugin(gate, { mode: 'progressive', residentTools: ['read'] })
  try {
    await fiber.await()
    assert.ok(tools.get(gate.GATE_TOOL), 'loader must register dev_tool_search')
    const assembly = await prompt.assemble({ agent: { session: { id: 'loader-regression', header: {}, events: [] } } })
    assert.ok(assembly.tools.some(tool => tool.name === gate.GATE_TOOL), 'new session must expose dev_tool_search')
  } finally { await fiber.dispose() }
})
