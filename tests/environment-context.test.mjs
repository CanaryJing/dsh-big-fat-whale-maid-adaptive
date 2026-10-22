import test from 'node:test'
import assert from 'node:assert/strict'
import { registerEnvironmentContext } from '../environment-context.mjs'
import { buildBrief } from '../env-probe.mjs'
import { readFileSync } from 'node:fs'

function harness(options) {
  const variables = {}
  const sections = []
  const events = []
  let hook
  registerEnvironmentContext({
    effect: (fn) => fn(),
    systemPrompt: {
      variable: (name, provider) => { variables[name] = provider },
      section: (section) => sections.push(section),
    },
    on: (name, handler) => { events.push(name); hook = handler },
  }, options)
  return {
    events,
    async assemble({ agent, model = 'old-model', provider = 'provider-a', finalRoute } = {}) {
      const context = { agent }
      const assembly = {
        variables: { model, provider, ...Object.fromEntries(Object.entries(variables).map(([k, fn]) => [k, fn(context)])) },
        sections: sections.map(({ name, text }) => ({ name, text: text(context) })),
        tools: [{ name: 'preserved-tool' }],
        contexts: [],
      }
      const result = await hook(assembly, context, async () => assembly)
      // DSH's official model-selection wrapper can update AFTER our hook.
      // Its final variables must still feed model/provider at render time.
      if (finalRoute) Object.assign(result.variables, finalRoute)
      return result
    },
  }
}

// Same single-pass variable substitution rule as DSH renderPrompt. A separate
// integration test can use the real installed service without adding deps here.
function render(assembly) {
  return assembly.sections.map((section) => section.text.replace(/\{\{([a-z][a-z0-9_]*)\}\}/g, (_all, key) => {
    assert.notEqual(assembly.variables[key], undefined)
    return assembly.variables[key]
  })).join('\n\n')
}

const agent = (cwd = 'D:\\工作区') => ({ options: { model: 'initial-model' }, session: { id: 's1', header: { cwd } } })
const describe = (snapshot, context) => `[ENV] ${snapshot.host}; cwd=${context.agent.session.header.cwd}`

test('first assembly awaits unfinished detection instead of showing pending/empty facts', async () => {
  let complete
  const ready = new Promise((resolve) => { complete = resolve })
  const h = harness({ getSnapshot: () => undefined, ready, describe })
  const pending = h.assemble({ agent: agent() })
  complete({ host: 'Windows' })
  const assembly = await pending
  assert.match(render(assembly), /\[ENV\] Windows; cwd=D:/)
  assert.deepEqual(assembly.tools, [{ name: 'preserved-tool' }])
})

test('model/provider identity uses final current route, never stale agent.options', async () => {
  const h = harness({ getSnapshot: () => ({ host: 'Windows' }), describe })
  const a = agent()
  const first = render(await h.assemble({ agent: a, finalRoute: { model: 'deepseek-pro', provider: 'official' } }))
  const second = render(await h.assemble({ agent: a, finalRoute: { model: 'gpt-current', provider: 'codex' } }))
  assert.match(first, /model=deepseek-pro; provider=official/)
  assert.match(second, /model=gpt-current; provider=codex/)
  assert.doesNotMatch(second, /initial-model|deepseek-pro/)
})

test('every request retains facts, including resume, compaction and changed cwd', async () => {
  const h = harness({ getSnapshot: () => ({ host: 'Linux' }), describe })
  for (const event of ['fresh', 'compaction/end', 'resume']) {
    const a = agent(`/home/${event}`)
    a.session.events = [{ type: event }]
    assert.match(render(await h.assemble({ agent: a })), /\[ENV\] Linux/)
  }
  assert.match(render(await h.assemble({ agent: agent('/changed') })), /cwd=\/changed/)
  assert.deepEqual(h.events, ['system-prompt/assemble'])
})

test('restart gets fresh system context, no duplicate durable user-message ids', async () => {
  for (let restart = 0; restart < 2; restart++) {
    const h = harness({ getSnapshot: () => ({ host: 'Windows' }), describe })
    const assembly = await h.assemble({ agent: agent() })
    assert.match(render(assembly), /\[ENV\]/)
    assert.equal(assembly.messages, undefined)
    assert.deepEqual(h.events, ['system-prompt/assemble'])
  }
})

test('refresh updates the cached snapshot for subsequent requests', async () => {
  let snapshot = { host: 'before-refresh' }
  const h = harness({ getSnapshot: () => snapshot, describe })
  assert.match(render(await h.assemble({ agent: agent() })), /before-refresh/)
  snapshot = { host: 'after-refresh' }
  assert.match(render(await h.assemble({ agent: agent() })), /after-refresh/)
})

test('literal braces in cwd are not interpolated as prompt variables', async () => {
  const h = harness({ getSnapshot: () => ({ host: 'Windows' }), describe })
  assert.match(render(await h.assemble({ agent: agent('C:\\{{not_a_variable}}') })), /\{\{not_a_variable\}\}/)
})

test('non-agent assembly is not polluted with undefined model references', async () => {
  const h = harness({ getSnapshot: () => undefined, describe })
  assert.equal(render(await h.assemble()), '')
})

test('brief reports missing WSL honestly, cache time, probe warnings, and all environment facts', () => {
  const brief = buildBrief({
    platform: 'win32', platformLabel: 'native Windows', probedAt: 0,
    wsl: { installed: false, distros: [] }, probeError: 'probe degraded',
    system: { os: 'Windows Test', cpu: 'CPU', threads: 8, memGB: 16, username: 'test', home: 'C:\\Users\\test' },
  }, 'D:\\工作区')
  for (const part of ['host:', 'hw:', 'user:', 'cwd:', 'shells:', 'files:', 'paths:', 'snapshot:', 'probe warning:']) {
    assert.ok(brief.includes(part), part)
  }
  assert.match(brief, /bash \[unavailable/)
  assert.match(brief, /not execution-tested/)
  assert.doesNotMatch(brief, /smoke: bash: uname/)
})

test('current bundle permits environment sections instead of discarding them via complete:true', () => {
  const bundle = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const policy = readFileSync(new URL('../shell-policy.mjs', import.meta.url), 'utf8')
  assert.match(bundle, /^\s+complete: false$/m)
  assert.doesNotMatch(bundle, /^\s+complete: true$/m)
  // The persona references the single routing source instead of embedding a
  // second, drift-prone copy of the shell table.
  assert.match(bundle, /shell-policy\.mjs/)
  assert.match(bundle, /single source of truth/i)
  assert.match(policy, /verified bound pwsh tool handles general Windows tasks/)
  assert.match(policy, /PowerShell-specific commands, \.ps1 scripts, or Windows UI automation/)
  assert.doesNotMatch(bundle, /12-year-old|double row of gold buttons/)
})
