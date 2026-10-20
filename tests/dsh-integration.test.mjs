import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { registerEnvironmentContext } from '../environment-context.mjs'
import { apply as applyRouter } from '../router-progressive.mjs'

const anchor = process.env.DSH_TEST_ANCHOR

test('real DSH registry + persona + official model selection preserve ENV and current route', { skip: !anchor }, async () => {
  const require = createRequire(resolve(anchor, 'package.json'))
  const load = (name) => import(pathToFileURL(require.resolve(name)).href)
  const { Context } = await load('@deepseek-ai/cordis')
  const { SystemPrompt, renderPrompt } = await load('@deepseek-ai/dsh-system-prompt')
  const { createScope, scopeTarget } = await load('@deepseek-ai/dsh-scope')
  const { installModelSelection } = await load('@deepseek-ai/dsh-agent')
  const persona = await load('@deepseek-ai/dsh-persona')
  const YAML = require('js-yaml')
  const JsExpr = new YAML.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (value) => value })
  const bundle = YAML.load(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), { schema: YAML.JSON_SCHEMA.extend(JsExpr) })
  const rows = bundle[0].insert[0].config.plugins
  const personaConfig = rows.find((row) => row.id === 'persona').config
  assert.equal(personaConfig.complete, false)

  const root = new Context()
  const prompt = new SystemPrompt(root, { includeHarnessIdentity: true })
  prompt.variable('model', ({ agent }) => agent?.options.model)
  prompt.variable('provider', ({ agent }) => agent?.options.provider)
  // Preset contributions belong to a standing scope; each agent joins below it.
  const presetKey = {}
  const presetScope = createScope(root, presetKey)
  const agentKey = {}
  const agentScope = createScope(root, agentKey, { parent: presetKey })
  try {
    persona.apply(presetScope.ctx, personaConfig)
    applyRouter({
      on: (...args) => presetScope.ctx.on(...args),
      effect: (fn) => fn(),
      tools: { register: () => () => {} },
    }, {})
    registerEnvironmentContext(presetScope.ctx, {
      getSnapshot: () => ({ host: 'integration-host' }),
      describe: (snapshot, { agent }) => `[ENV] host=${snapshot.host}; cwd=${agent.session.header.cwd}`,
    })
    const selection = { current: { model: 'dsv41flash', provider: 'deepseek' } }
    const dispose = installModelSelection(agentScope.ctx, selection)
    try {
      const agent = {
        options: { model: 'stale-initial', provider: 'stale-provider' },
        session: {
          header: { cwd: 'D:\\{{literal-braces}}' },
          events: [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '创建一个网页' }] } }],
        },
      }
      for (const route of [selection.current, { model: 'changed-model', provider: 'changed-provider' }]) {
        selection.current = route
        const assembly = await prompt.assemble({ scope: agentKey, agent })
        const rendered = renderPrompt(assembly)
        assert.match(rendered, /\[ENV\] host=integration-host/)
        assert.match(rendered, /think in Chinese \(简体中文\)/)
        assert.match(rendered, /\{\{literal-braces\}\}/)
        assert.ok(rendered.includes(`model=${route.model}; provider=${route.provider}`))
        assert.doesNotMatch(rendered, /stale-initial|stale-provider/)
        assert.match(rendered, /Task mode \(react\)/)
        assert.deepEqual(assembly.contexts, [])
        const request = await root.waterfall(scopeTarget(root, agentKey), 'agent/request', {}, async () => ({ model: 'stale-initial', provider: 'stale-provider' }))
        assert.equal(request.model, route.model)
        assert.equal(request.provider, route.provider)
      }
      // Same runtime reproduces the old complete:true trap, proving the
      // configuration change is essential rather than decorative.
      const root2 = new Context()
      const prompt2 = new SystemPrompt(root2, { includeHarnessIdentity: false })
      prompt2.section({ name: 'only-persona', order: 0, text: 'persona', complete: true })
      prompt2.section({ name: 'environment-discarded', order: 10, text: '[ENV] should disappear' })
      assert.equal(renderPrompt(await prompt2.assemble()), 'persona')
    } finally { dispose() }
  } finally {
    await agentScope.dispose()
    await presetScope.dispose()
  }
})
