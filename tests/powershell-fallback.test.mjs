import test from 'node:test'
import assert from 'node:assert/strict'
import { detectPowerShellRuntime } from '../powershell-runtime.mjs'

const core = 'C:\\Tools\\pwsh.exe'
const desktop = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const output = (path, version, edition) => '__WHALE_PWSH_RUNTIME__' + JSON.stringify({ path, version, edition })
function mock({ platform = 'win32', programs = {}, paths = {}, native = '/usr/bin/pwsh' } = {}) {
  const calls = []
  const options = {
    platform, env: { SystemRoot: 'C:\\Windows' },
    readDir: async () => [], resolvePath: async (path) => path,
    run: async (argv) => {
      calls.push(argv)
      if (argv[0].toLowerCase().endsWith('where.exe')) return paths[argv[1]] ?? ''
      if (argv[0] === '/bin/sh') return native
      if (!(argv[0] in programs)) throw new Error('ENOENT mock')
      const result = programs[argv[0]]
      if (result instanceof Error) throw result
      return result
    },
  }
  return { calls, options }
}

test('PowerShell 7 always wins; default 5.1 is never executed when 7 is usable', async () => {
  const m = mock({ programs: { [core]: output(core, '7.5.2', 'Core'), [desktop]: output(desktop, '5.1.26100.1000', 'Desktop') }, paths: { 'pwsh.exe': core, 'powershell.exe': desktop } })
  const result = await detectPowerShellRuntime(m.options)
  assert.equal(result.runtime.path, core)
  assert.equal(result.runtime.isFallback, false)
  assert.equal(result.warning, undefined)
  assert.ok(!m.calls.some((argv) => argv[0] === desktop || argv[1] === 'powershell.exe'))
})

test('without 7, default Windows PowerShell 5.1 remains available and reports actual version', async () => {
  const m = mock({ programs: { [desktop]: output(desktop, '5.1.26100.1000', 'Desktop') }, paths: { 'powershell.exe': desktop } })
  const result = await detectPowerShellRuntime(m.options)
  assert.equal(result.runtime.path, desktop)
  assert.equal(result.runtime.version, '5.1.26100.1000')
  assert.equal(result.runtime.isFallback, true)
  assert.match(result.warning, /default fallback PowerShell 5.1.26100.1000/)
  assert.equal(result.runtime.argv[0], desktop)
  assert.match(result.runtime.label, /Desktop; default fallback/)
})

test('SystemRoot default is usable even if where.exe finds no PowerShell', async () => {
  const m = mock({ programs: { [desktop]: output(desktop, '5.1.26100.1000', 'Desktop') } })
  assert.equal((await detectPowerShellRuntime(m.options)).runtime.path, desktop)
})

test('without 7, default pwsh Core 6 is chosen before Windows 5.1', async () => {
  const m = mock({ programs: { [core]: output(core, '6.2.7', 'Core'), [desktop]: output(desktop, '5.1.26100.1000', 'Desktop') }, paths: { 'pwsh.exe': core, 'powershell.exe': desktop } })
  const result = await detectPowerShellRuntime(m.options)
  assert.equal(result.runtime.path, core)
  assert.equal(result.runtime.version, '6.2.7')
  assert.equal(result.runtime.isFallback, true)
  assert.ok(!m.calls.some((argv) => argv[0] === desktop))
})

test('native default pwsh Core 6 is bound to an absolute native path', async () => {
  const m = mock({ platform: 'linux', programs: { '/usr/bin/pwsh': output('/usr/bin/pwsh', '6.2.7', 'Core') } })
  const result = await detectPowerShellRuntime(m.options)
  assert.equal(result.runtime.path, '/usr/bin/pwsh')
  assert.equal(result.runtime.isFallback, true)
  assert.equal(result.runtime.windowsInterop, false)
})

test('no default or invalid version/edition/output never manufactures a runtime', async () => {
  for (const value of [new Error('missing'), 'no marker', output(desktop, '5.1.26100.1000', 'Core'), output(desktop, '5.0.0', 'Desktop'), output('relative.exe', '5.1.26100.1000', 'Desktop')]) {
    const m = mock({ programs: { [desktop]: value }, paths: { 'powershell.exe': desktop } })
    const result = await detectPowerShellRuntime(m.options)
    assert.equal(result.runtime, undefined)
    assert.match(result.warning, /default PowerShell unavailable/)
  }
})

test('explicit invalid or missing pin never falls back to an available system default', async () => {
  for (const pinnedPath of ['', null, core, desktop]) {
    const m = mock({ programs: { [desktop]: output(desktop, '5.1.26100.1000', 'Desktop') }, paths: { 'powershell.exe': desktop } })
    const result = await detectPowerShellRuntime({ ...m.options, pinnedPath })
    assert.equal(result.runtime, undefined)
    assert.match(result.warning, /pinnedPath/)
    assert.ok(!m.calls.some((argv) => argv[0].toLowerCase().endsWith('where.exe')))
    assert.ok(m.calls.every((argv) => argv[0] === pinnedPath))
  }
})

test('default launcher redirect is revalidated before binding and stale identity is rejected', async () => {
  const launcher = 'C:\\Launch\\powershell.exe'
  const m = mock({ programs: { [launcher]: output(desktop, '5.1.26100.1000', 'Desktop'), [desktop]: output(desktop, '5.1.26100.1000', 'Desktop') }, paths: { 'powershell.exe': launcher } })
  const result = await detectPowerShellRuntime(m.options)
  assert.equal(result.runtime.path, desktop)
  assert.equal(result.runtime.isFallback, true)
  assert.ok(m.calls.some((argv) => argv[0] === launcher))
  assert.ok(m.calls.some((argv) => argv[0] === desktop))
})
