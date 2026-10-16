import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { apply } from '../env-probe.mjs'

const execFileAsync = promisify(execFile)

test('real registered pwsh tool runs verified 7, correct cwd and Chinese; invalid cwd never executes', {
  skip: !process.env.PWSH_RUNTIME_REAL_PATH,
}, async () => {
  const tools = new Map()
  const effects = []
  const variables = new Map()
  const sections = []
  const listeners = new Map()
  const spawns = []
  apply({
    baseUrl: new URL('../', import.meta.url).href,
    logger: { warn: (warning) => assert.fail(warning) },
    effect(fn) { const result = fn(); if (result?.then) effects.push(result) },
    tools: { register: (tool) => { tools.set(tool.name, tool); return () => {} } },
    systemPrompt: {
      variable: (name, provider) => variables.set(name, provider),
      section: (section) => sections.push(section),
    },
    on: (name, handler) => listeners.set(name, handler),
    subprocess: {
      spawn(options) {
        spawns.push(options)
        const collected = { stdout: '', stderr: '' }
        const done = execFileAsync(options.argv[0], options.argv.slice(1), {
          cwd: options.cwd, encoding: 'utf8', windowsHide: true, timeout: 10000,
          env: { ...process.env, ...options.env }, maxBuffer: 64000,
        }).then(({ stdout, stderr }) => {
          Object.assign(collected, { stdout, stderr }); return { exitCode: 0 }
        }, (error) => {
          collected.stdout = String(error.stdout ?? '')
          collected.stderr = String(error.stderr ?? error.message)
          return { exitCode: typeof error.code === 'number' ? error.code : -1 }
        })
        return {
          done,
          collected: {
            stdout: { readFrom: () => ({ text: collected.stdout }) },
            stderr: { readFrom: () => ({ text: collected.stderr }) },
          },
        }
      },
    },
  }, { probeTimeoutMs: 5000, pwshPath: process.env.PWSH_RUNTIME_REAL_PATH })
  await Promise.all(effects)
  const pwsh = tools.get('pwsh')
  assert.ok(pwsh, 'verified PowerShell tool must register')
  const cwd = fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]$/, '')
  const agent = { session: { header: { cwd } } }
  const result = await pwsh.execute({ command: "[ordered]@{version=$PSVersionTable.PSVersion.ToString();path=(Get-Process -Id $PID).Path;cwd=(Get-Location).Path;message='中文验证'} | ConvertTo-Json -Compress" }, { agent })
  const actual = JSON.parse(result.text.trim())
  assert.ok(Number(actual.version.split('.')[0]) >= 7)
  assert.equal(actual.cwd.toLowerCase(), cwd.toLowerCase())
  assert.equal(actual.message, '中文验证')
  assert.equal(spawns[0].argv[0].toLowerCase(), actual.path.toLowerCase())
  assert.ok(pwsh.description.includes(actual.version))
  assert.ok(pwsh.description.includes(actual.path))
  const paramResult = await pwsh.execute({ command: "param([string]$word='绑定验证'); $word" }, { agent })
  assert.equal(paramResult.text.trim(), '绑定验证')
  await assert.rejects(() => pwsh.execute({ command: 'exit 23' }, { agent }), /exit code: 23/)
  assert.ok(spawns.every((spawn) => spawn.argv[0].toLowerCase() === actual.path.toLowerCase()), 'no execution-time fallback')
  for (const workdir of ['', 'relative-dir', 'C:drive-relative', null, 'bad\0dir']) {
    const count = spawns.length
    await assert.rejects(() => pwsh.execute({ command: 'Write-Output SHOULD_NOT_RUN', workdir }, { agent }))
    assert.equal(spawns.length, count, 'invalid directory must be rejected before spawn')
  }
  const badDirectory = process.platform === 'win32' ? 'C:\\__whale_missing_20261016__' : '/__whale_missing_20261016__'
  await assert.rejects(() => pwsh.execute({ command: 'Write-Output SHOULD_NOT_RUN', workdir: badDirectory }, { agent }), (error) => !error.message.includes('\nSHOULD_NOT_RUN\n'))

  const hook = listeners.get('system-prompt/assemble')
  const assembly = await hook({}, { agent }, async () => ({ variables: {}, tools: [] }))
  assert.ok(assembly.variables.whale_environment.includes(actual.path))
  assert.ok(assembly.variables.whale_environment.includes(actual.version))
  assert.ok(!listeners.has('agent/pre-step'), 'environment must not append historical user messages')
})
