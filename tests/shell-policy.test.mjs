import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerEnvironmentContext } from '../environment-context.mjs'
import { buildBrief } from '../env-probe.mjs'
import {
  SHELL_ROUTING_SUMMARY,
  SHELL_ROUTING_SECTION,
  SHELL_ROUTING_SECTION_NAME,
  SHELL_ROUTING_SECTION_ORDER,
  registerShellPolicy,
} from '../shell-policy.mjs'

function promptHarness() {
  const sections = []
  const variables = []
  const listeners = []
  const ctx = {
    effect: (fn) => fn(),
    systemPrompt: {
      variable: (name, provider) => variables.push({ name, provider }),
      section: (section) => sections.push(section),
    },
    on: (name, handler) => listeners.push({ name, handler }),
  }
  return { ctx, sections, variables, listeners }
}

function assertRoutingText(value) {
  assert.match(value, /Windows general execution: prefer gitbash first/i)
  assert.match(value, /when Git Bash is unavailable, the verified bound pwsh tool handles general Windows tasks/i)
  assert.match(value, /pwsh is also the choice for PowerShell-specific commands, \.ps1 scripts, or Windows UI automation/i)
  assert.match(value, /Use bash only for Linux-only work; it is never the Windows fallback/i)
  assert.match(value, /native Linux\/macOS\/Android use their native shell/i)
  assert.match(value, /ops_bash is an execution entry point/i)
  assert.match(value, /does not compete with the Windows gitbash preference/i)
  assert.match(value, /invalid or unsupported workdir stops execution/i)
  assert.match(value, /never switches to an older PowerShell or a different shell/i)
  assert.match(value, /permission\/approval denial is never bypassed/i)
  assert.doesNotMatch(value, /bash only for Linux-only work or when Git Bash is unavailable/i,
    'WSL bash must never be the Windows fallback')
}

test('shell routing is one shared string used by the env brief and the late prompt section', () => {
  assert.match(SHELL_ROUTING_SECTION, new RegExp(SHELL_ROUTING_SUMMARY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assertRoutingText(SHELL_ROUTING_SUMMARY)
  assertRoutingText(SHELL_ROUTING_SECTION)
  assert.match(SHELL_ROUTING_SECTION, /single source of truth/i)
  assert.match(SHELL_ROUTING_SECTION, /takes precedence over generic shell-first suggestions/i)
  assert.match(SHELL_ROUTING_SECTION, /never overrides plan mode, approval, sandbox, or file rules/i)
})

test('registry-shaped section is registered late and does not replace ENV/model/persona', () => {
  const h = promptHarness()
  registerEnvironmentContext(h.ctx, {
    getSnapshot: () => ({ host: 'test-host' }),
    ready: Promise.resolve(),
    describe: () => '[ENV] test-host',
  })
  registerShellPolicy(h.ctx)
  h.sections.push({ name: 'persona', order: 0, text: 'You are the whale maid.\n[MODEL] {{model}} / {{provider}}' })

  const byName = new Map(h.sections.map((section) => [section.name, section]))
  assert.ok(byName.has('whale-maid:environment'), 'ENV section must stay registered')
  const envText = byName.get('whale-maid:environment').text({ agent: { session: { header: { cwd: 'D:\\workspace' } } } })
  assert.match(envText, /\{\{whale_environment\}\}/)
  assert.match(envText, /\[MODEL\]/)
  assert.ok(byName.has('persona'), 'persona must stay registered')
  const shell = byName.get(SHELL_ROUTING_SECTION_NAME)
  assert.ok(shell, 'shell routing section must be registered')
  assert.equal(shell.order, SHELL_ROUTING_SECTION_ORDER)
  assert.ok(shell.order > 10, 'shell routing must come after the ENV/model section')
  assert.ok(shell.order > 0, 'shell routing must come after persona')
  assert.equal(shell.text, SHELL_ROUTING_SECTION)

  const ordered = [...h.sections].sort((a, b) => a.order - b.order).map((section) => section.name)
  assert.deepEqual(ordered, ['persona', 'whale-maid:environment', SHELL_ROUTING_SECTION_NAME])
})

test('env brief carries the same routing summary and still has host/cwd/model-adjacent facts', () => {
  const brief = buildBrief({
    platform: 'win32', platformLabel: 'native Windows', probedAt: 0,
    wsl: { installed: true, distros: ['Debian'], defaultDistro: 'Debian' },
    gitbash: { label: 'Git Bash', argv: ['C:\\Git\\bin\\bash.exe', '-lc'] },
    system: { os: 'Windows Test', cpu: 'CPU', threads: 8, memGB: 16, username: 'test', home: 'C:\\Users\\test' },
  }, 'D:\\工作区')
  assert.ok(brief.includes(`shell routing: ${SHELL_ROUTING_SUMMARY}`))
  assert.match(brief, /^host:/m)
  assert.match(brief, /^cwd:/m)
  assert.match(brief, /^shells:/m)
})

test('tool descriptions use the shared policy and no longer claim gitbash is first for EVERY environment', () => {
  const env = readFileSync(new URL('../env-probe.mjs', import.meta.url), 'utf8')
  const wsl = readFileSync(new URL('../wsl-bash.mjs', import.meta.url), 'utf8')
  assert.match(env, /SHELL_ROUTING_SUMMARY/)
  assert.match(wsl, /SHELL_ROUTING_SUMMARY/)
  assert.doesNotMatch(env, /FIRST-CHOICE shell for EVERY environment/)
  assert.doesNotMatch(wsl, /prefer the `gitbash` tool FIRST for every shell task/)
  assert.match(env, /use this bound pwsh tool for PowerShell-specific commands/i)
  assert.match(env, /Windows fallback when Git Bash is unavailable|Windows fallback for general Windows execution/)
  assert.match(wsl, /never the Windows fallback when Git Bash is unavailable/)
})

test('persona references the dedicated routing section instead of duplicating it', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const persona = patch.slice(patch.indexOf('- id: persona'))
  assert.match(persona, /Shell routing: follow the dedicated/i)
  assert.match(persona, /shell-policy\.mjs/)
  assert.match(persona, /single source of truth/i)
  assert.match(persona, /Reasoning language: think in Chinese/)
  // No second copy of the routing table inside the persona.
  assert.doesNotMatch(persona, /Windows general execution prefers gitbash/)
  assert.doesNotMatch(persona, /pwsh only for PowerShell-specific commands/i)
  assert.doesNotMatch(persona, /bash only for Linux-only work/i)
})

test('real SystemPrompt assembly places shell routing after built-in host sections', {
  skip: !process.env.DSH_TEST_ANCHOR,
}, async () => {
  const anchor = process.env.DSH_TEST_ANCHOR
  const require = createRequire(resolve(anchor, 'package.json'))
  const load = (name) => import(pathToFileURL(require.resolve(name)).href)
  const { Context } = await load('@deepseek-ai/cordis')
  const { SystemPrompt, renderPrompt } = await load('@deepseek-ai/dsh-system-prompt')
  const root = new Context()
  // The engine owns sections up to DEPLOYMENT_PERSONA_SUFFIX (10200). A mock
  // assertion on order=90 could not prove placement against these.
  const prompt = new SystemPrompt(root, {
    includeHarnessIdentity: true,
    personaSuffix: 'HOST-RULE: deployment persona suffix must appear before shell routing.',
  })
  registerShellPolicy(root)
  root.systemPrompt.section({ name: 'host:late-rule', order: 10250, text: 'HOST-LATE-RULE: a late host section.' })
  const rendered = renderPrompt(await prompt.assemble({
    agent: { session: { header: { cwd: process.cwd() }, events: [] } },
  }))
  const suffixIndex = rendered.indexOf('HOST-RULE: deployment persona suffix')
  const lateIndex = rendered.indexOf('HOST-LATE-RULE')
  const shellIndex = rendered.indexOf('Shell routing (preset-specific')
  assert.ok(suffixIndex >= 0, 'built-in persona suffix must render')
  assert.ok(lateIndex > suffixIndex, 'host late rule renders after persona suffix')
  assert.ok(shellIndex > lateIndex, 'shell routing must render after real host sections')
  assert.match(rendered.slice(shellIndex), /single source of truth/i)
})
