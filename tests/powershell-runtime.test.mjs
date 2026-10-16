import test from 'node:test'
import assert from 'node:assert/strict'
import { detectPowerShell7, detectPowerShellRuntime } from '../powershell-runtime.mjs'

const marker = '__WHALE_PWSH_RUNTIME__'
const flags = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']
const windowsPath = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const nativePath = '/opt/microsoft/powershell/7/pwsh'
const output = (path, version = '7.4.6', edition = 'Core') => `${marker}${JSON.stringify({ path, version, edition })}\n`

// Every unit-test subprocess and filesystem read is mocked, including missing candidates.
function fixture({ platform = 'win32', outputs = {}, directories = {}, links = {}, env = {}, where = '', command = '' } = {}) {
  const calls = []
  const reads = []
  const resolutions = []
  const options = {
    platform, env,
    readDir: async (path) => { reads.push(path); return directories[path] ?? [] },
    resolvePath: async (path) => { resolutions.push(path); return links[path] ?? path },
    run: async (argv, timeoutMs) => {
      calls.push({ argv, timeoutMs })
      if (argv[0].toLowerCase().endsWith('where.exe')) {
        assert.deepEqual(argv.slice(1), ['pwsh.exe'])
        if (where instanceof Error) throw where
        return where
      }
      if (argv[0] === '/bin/sh') {
        assert.deepEqual(argv, ['/bin/sh', '-c', 'command -v pwsh'])
        if (command instanceof Error) throw command
        return command
      }
      assert.deepEqual(argv.slice(1, 5), flags)
      assert.equal(argv.length, 6)
      assert.match(argv[5], /\(Get-Process -Id \$PID -ErrorAction Stop\)\.Path/)
      assert.match(argv[5], /\$PSVersionTable\.PSVersion/)
      assert.match(argv[5], /\$PSVersionTable\.PSEdition/)
      assert.match(argv[5], /\$ErrorActionPreference='Stop'/)
      const result = outputs[argv[0]]
      if (result instanceof Error) throw result
      if (result === undefined) throw new Error('ENOENT (mock)')
      return result
    },
  }
  return { options, calls, reads, resolutions }
}

function assertBound(result, path, version = '7.4.6') {
  assert.equal(result.warning, undefined)
  assert.deepEqual(result.runtime, {
    label: `PowerShell ${version} (Core)`, path, version,
    argv: [path, ...flags], windowsInterop: false,
  })
}

function assertUnavailable(result, pattern = /unavailable/i) {
  assert.equal(result.runtime, undefined)
  assert.match(result.warning, pattern)
}

test('Windows pinned path binds exact executable and does not enumerate or search PATH', async () => {
  const f = fixture({ outputs: { [windowsPath]: output(windowsPath) } })
  assertBound(await detectPowerShell7({ ...f.options, pinnedPath: windowsPath, timeoutMs: 1234 }), windowsPath)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].timeoutMs, 1234)
  assert.deepEqual(f.reads, [])
})

test('invalid explicit pins fail closed before any process or filesystem access', async () => {
  for (const pinnedPath of ['', null, false, 123, {}, [], 'pwsh.exe', 'C:pwsh.exe', '\\pwsh.exe', 'C:\\bad\0pwsh.exe', 'C:\\bad\npwsh.exe', '\\\\?\\C:\\pwsh.exe', '\\\\server']) {
    const f = fixture({ outputs: { [windowsPath]: output(windowsPath) } })
    assertUnavailable(await detectPowerShell7({ ...f.options, pinnedPath }), /pinnedPath/)
    assert.equal(f.calls.length, 0)
    assert.equal(f.reads.length, 0)
  }
})

test('missing pinned runtime, timeout, stderr contract and exit errors never try another executable', async () => {
  for (const error of [new Error('ENOENT'), new Error('timed out'), new Error('subprocess emitted stderr'), new Error('exit code 1')]) {
    const f = fixture({ outputs: { [windowsPath]: error }, where: 'C:\\Other\\pwsh.exe' })
    assertUnavailable(await detectPowerShell7({ ...f.options, pinnedPath: windowsPath }), /pinnedPath rejected; no fallback/)
    assert.equal(f.calls.length, 1)
    assert.equal(f.calls[0].argv[0], windowsPath)
    assert.equal(f.reads.length, 0)
  }
})

test('validation rejects 5.1, Desktop, malformed JSON, absent/invalid process paths and excessive output', async () => {
  const invalid = [
    output(windowsPath, '5.1.26100', 'Desktop'), output(windowsPath, '5.1.0'),
    output(windowsPath, '7.5.0', 'Desktop'), output(windowsPath, '7.5.0', 'core'),
    output(windowsPath, '7.5'), output(windowsPath, '7.5.0evil'), output(windowsPath, '7.05.0'),
    output(windowsPath, '7.5.0\0'), output(windowsPath, '99999999999999999.0.0'),
    output('pwsh.exe'), output('C:pwsh.exe'), output('C:\\bad\0pwsh.exe'), output('C:\\bad\npwsh.exe'),
    `${marker}null`, `${marker}{`, `${marker}{"version":"7.5.0","edition":"Core"}`,
    JSON.stringify({ path: windowsPath, version: '7.5.0', edition: 'Core' }),
    'PowerShell error: access denied', `${output(windowsPath)}\0`, 'x'.repeat(65537),
    `${output(windowsPath)}${marker}not-json`,
  ]
  for (const stdout of invalid) {
    const f = fixture({ outputs: { [windowsPath]: stdout } })
    assertUnavailable(await detectPowerShell7({ ...f.options, pinnedPath: windowsPath }))
    assert.equal(f.calls.length, 1)
  }
})

test('marker JSON ignores unrelated banner/JSON stdout and uses the last marker record', async () => {
  const stdout = `banner\r\n{"version":"99.0.0"}\r\n${output(windowsPath, '7.3.0')}${output(windowsPath)}trailing unrelated output\n`
  const f = fixture({ outputs: { [windowsPath]: stdout } })
  assertBound(await detectPowerShell7({ ...f.options, pinnedPath: windowsPath }), windowsPath)
})

test('Windows enumerates every 7* folder, per-user installs, WindowsApps and where.exe candidates', async () => {
  const local = 'D:\\User\\Local'
  const root = 'D:\\Apps\\PowerShell'
  const userRoot = `${local}\\Programs\\PowerShell`
  const msUserRoot = `${local}\\Microsoft\\PowerShell`
  const apps = 'D:\\Apps\\WindowsApps'
  const alias = `${local}\\Microsoft\\WindowsApps\\pwsh.exe`
  const storeName = 'Microsoft.PowerShell_7.6.1.0_x64__8wekyb3d8bbwe'
  const storePreview = 'Microsoft.PowerShellPreview_7.9.0.0_x64__8wekyb3d8bbwe'
  const paths = [
    `${root}\\7.4.1\\pwsh.exe`, `${root}\\7-custom\\pwsh.exe`,
    `${userRoot}\\7.5.0\\pwsh.exe`, `${msUserRoot}\\7\\pwsh.exe`,
    `${apps}\\${storeName}\\pwsh.exe`, `${apps}\\${storePreview}\\pwsh.exe`, alias,
    'E:\\Portable\\pwsh.exe',
  ]
  const outputs = Object.fromEntries(paths.map((path, i) => [path, output(path, `7.${i}.0`)]))
  const f = fixture({
    env: { programfiles: 'D:\\Apps', LOCALAPPDATA: local, SystemRoot: 'C:\\Windows' },
    directories: {
      [root]: ['7.4.1', '7-custom', '6', '..\\evil', '7\0bad'],
      [userRoot]: ['7.5.0'], [apps]: [storeName, storePreview, 'Unrelated_7.99'],
    },
    outputs, where: `E:\\Portable\\pwsh.exe\r\nrelative.exe\r\nC:\\bad\0pwsh.exe\n`,
  })
  assertBound(await detectPowerShell7(f.options), paths.at(-1), '7.7.0')
  for (const path of paths) assert.ok(f.calls.some(({ argv }) => argv[0] === path), path)
  assert.ok(f.calls.some(({ argv }) => argv[0] === 'C:\\Windows\\System32\\where.exe'))
  assert.ok(!f.calls.some(({ argv }) => /powershell\.exe$/i.test(argv[0])))
  assert.ok(!f.calls.some(({ argv }) => argv[0].includes('\0')))
})

test('highest stable version wins numerically over higher previews, independent of discovery order', async () => {
  const paths = ['C:\\a\\pwsh.exe', 'C:\\b\\pwsh.exe', 'C:\\c\\pwsh.exe', 'C:\\d\\pwsh.exe']
  const versions = ['7.9.9', '8.0.0-preview.10', '7.10.0', '7.8.100']
  const f = fixture({ where: paths.join('\n'), outputs: Object.fromEntries(paths.map((path, i) => [path, output(path, versions[i])])) })
  assertBound(await detectPowerShell7(f.options), paths[2], versions[2])
})

test('preview-only installs use descending SemVer prerelease precedence and allow future majors', async () => {
  const versions = ['7.6.0-preview.9', '7.6.0-preview.10', '7.6.0-preview.2']
  const paths = versions.map((_, i) => `C:\\preview-${i}\\pwsh.exe`)
  const f = fixture({ where: paths.join('\n'), outputs: Object.fromEntries(paths.map((path, i) => [path, output(path, versions[i])])) })
  assertBound(await detectPowerShell7(f.options), paths[1], versions[1])
  const future = fixture({ outputs: { [windowsPath]: output(windowsPath, '8.0.1+build.1') } })
  assertBound(await detectPowerShell7({ ...future.options, pinnedPath: windowsPath }), windowsPath, '8.0.1+build.1')
})

test('Windows candidate deduplication is case-insensitive and PATH failure does not hide an installation', async () => {
  const f = fixture({ outputs: { [windowsPath]: output(windowsPath) }, where: `${windowsPath}\n${windowsPath.toUpperCase()}\n` })
  assertBound(await detectPowerShell7(f.options), windowsPath)
  assert.equal(f.calls.filter(({ argv }) => argv[0].toLowerCase() === windowsPath.toLowerCase()).length, 1)
  const g = fixture({ outputs: { [windowsPath]: output(windowsPath) }, where: new Error('where absent') })
  assertBound(await detectPowerShell7(g.options), windowsPath)
})

test('WindowsApps aliases bind the reported executable only after revalidating that absolute path', async () => {
  const alias = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe'
  const actual = 'C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.5.0_x64\\pwsh.exe'
  const f = fixture({ outputs: { [alias]: output(actual), [actual]: output(actual) } })
  assertBound(await detectPowerShell7({ ...f.options, pinnedPath: alias }), actual)
  assert.deepEqual(f.calls.map(({ argv }) => argv[0]), [alias, actual])
  for (const second of [new Error('ENOENT'), output(actual, '5.1.0', 'Desktop'), output('C:\\third\\pwsh.exe')]) {
    const g = fixture({ outputs: { [alias]: output(actual), [actual]: second } })
    assertUnavailable(await detectPowerShell7({ ...g.options, pinnedPath: alias }))
    assert.equal(g.calls.length, 2)
  }
})

test('UNC executable paths are absolute and bind case-insensitively without reexecuting', async () => {
  const path = '\\\\server\\share\\PowerShell\\pwsh.exe'
  const f = fixture({ outputs: { [path]: output(path.toUpperCase()) } })
  assertBound(await detectPowerShell7({ ...f.options, pinnedPath: path }), path.toUpperCase())
  assert.equal(f.calls.length, 1)
})

for (const platform of ['linux', 'darwin']) {
  test(`${platform}: command -v and realpath bind native Core with spaces and no Windows/WSL fallback`, async () => {
    const link = '/usr/local/bin/pwsh'
    const actual = '/Applications/Power Shell/7/pwsh'
    const f = fixture({ platform, command: `${link}\n`, links: { [link]: actual }, outputs: { [actual]: `banner\n${output(actual)}` } })
    assertBound(await detectPowerShell7(f.options), actual)
    assert.deepEqual(f.resolutions, [link, actual])
    assert.equal(f.calls.length, 2)
    assert.equal(f.reads.length, 0)
    assert.ok(!f.calls.some(({ argv }) => /wsl|\.exe$/i.test(argv[0])))
  })
}

test('native pinned symlink bypasses PATH and is canonicalized before execution', async () => {
  const link = '/usr/local/bin/pwsh'
  const f = fixture({ platform: 'linux', links: { [link]: nativePath }, outputs: { [nativePath]: output(nativePath) } })
  assertBound(await detectPowerShell7({ ...f.options, pinnedPath: link }), nativePath)
  assert.equal(f.calls.length, 1)
})

test('native wrapper-reported process path is executed again and must keep the same identity', async () => {
  const wrapper = '/opt/bin/pwsh'
  const f = fixture({ platform: 'linux', outputs: { [wrapper]: output(nativePath), [nativePath]: output(nativePath) } })
  assertBound(await detectPowerShell7({ ...f.options, pinnedPath: wrapper }), nativePath)
  assert.deepEqual(f.calls.map(({ argv }) => argv[0]), [wrapper, nativePath])
})

test('native absent, aliased, relative, multi-line, NUL or Windows PATH discoveries fail closed', async () => {
  for (const command of ['', 'pwsh', 'pwsh is a function', 'C:\\PowerShell\\pwsh.exe', '/usr/bin/pwsh\n/evil/pwsh', '/usr/bin/pwsh\0', new Error('no pwsh')]) {
    const f = fixture({ platform: 'linux', command, env: { WSL_DISTRO_NAME: 'Debian', WSL_INTEROP: '/run/WSL/1_interop' } })
    assertUnavailable(await detectPowerShell7(f.options))
    assert.equal(f.calls.length, 1)
  }
  const f = fixture({ platform: 'linux' })
  assertUnavailable(await detectPowerShell7({ ...f.options, pinnedPath: windowsPath }), /pinnedPath/)
  assert.equal(f.calls.length, 0)
})

test('native realpath failures, relative results and foreign process paths fail closed', async () => {
  for (const options of [
    { resolvePath: async () => { throw new Error('broken symlink') } },
    { resolvePath: async () => 'relative' },
    { resolvePath: async () => 'C:\\pwsh.exe' },
  ]) {
    const f = fixture({ platform: 'linux', outputs: { [nativePath]: output(nativePath) } })
    assertUnavailable(await detectPowerShell7({ ...f.options, ...options, pinnedPath: nativePath }))
    assert.equal(f.calls.length, 0)
  }
  const f = fixture({ platform: 'linux', outputs: { [nativePath]: output(windowsPath) } })
  assertUnavailable(await detectPowerShell7({ ...f.options, pinnedPath: nativePath }))
})

test('filesystem enumeration failure is optional and never prevents where.exe verification', async () => {
  const portable = 'E:\\portable\\pwsh.exe'
  const f = fixture({ where: portable, outputs: { [portable]: output(portable) } })
  assertBound(await detectPowerShell7({ ...f.options, readDir: async () => { throw new Error('EACCES') } }), portable)
})

test('bad options fail unavailable without side effects', async () => {
  for (const options of [
    { platform: 'freebsd' }, { timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: 1.5 },
    { timeoutMs: Infinity }, { timeoutMs: 2147483648 }, { env: null }, { env: [] },
    { run: null }, { readDir: null }, { resolvePath: null },
  ]) {
    const f = fixture()
    assertUnavailable(await detectPowerShell7({ ...f.options, ...options }))
    assert.equal(f.calls.length, 0)
    assert.equal(f.reads.length, 0)
  }
})

test('a stale returned binding is just absolute argv; execution failure has no discovery or fallback behavior', async () => {
  const f = fixture({ outputs: { [windowsPath]: output(windowsPath) } })
  const { runtime } = await detectPowerShell7({ ...f.options, pinnedPath: windowsPath })
  assert.deepEqual(runtime.argv, [windowsPath, ...flags])
  const priorCalls = f.calls.length
  const execute = async (argv) => { assert.equal(argv[0], windowsPath); throw new Error('ENOENT: stale binding') }
  await assert.rejects(execute([...runtime.argv, 'Write-Output test']), /stale binding/)
  assert.equal(f.calls.length, priorCalls)
})

test('opt-in single real local PowerShell 7 binding (never Windows 5.1 or WSL)', {
  skip: !process.env.PWSH_RUNTIME_REAL_PATH,
}, async () => {
  const result = await detectPowerShell7({ pinnedPath: process.env.PWSH_RUNTIME_REAL_PATH })
  assert.ok(result.runtime, result.warning)
  assert.ok(Number(result.runtime.version.split('.')[0]) >= 7)
  assert.equal(result.runtime.argv[0], result.runtime.path)
  assert.equal(result.runtime.windowsInterop, false)
})
