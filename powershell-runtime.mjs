/** Verified PowerShell discovery and executable binding. Node built-ins only. */
import { execFile } from 'node:child_process'
import { readdir, realpath } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const FLAGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']
const MARKER = '__WHALE_PWSH_RUNTIME__'
const MAX_OUTPUT = 64 * 1024
const UTF8 = '$OutputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);'

/** UTF-8 only inside this child process; no system locale/codepage changes. */
export function powerShellCommand(command) {
  if (typeof command !== 'string' || command.includes('\0')) throw new TypeError('PowerShell command must be a string without NUL')
  return `${UTF8} & {\n${command}\n}`
}

const PROBE = `${UTF8} $ErrorActionPreference='Stop'; try { $v=$PSVersionTable.PSVersion; $p=(Get-Process -Id $PID -ErrorAction Stop).Path; if ([string]::IsNullOrEmpty($p)) { throw 'Missing process path' }; $j=@{version=$v.ToString();edition=[string]$PSVersionTable.PSEdition;path=[string]$p} | ConvertTo-Json -Compress; [Console]::Out.WriteLine('${MARKER}'+$j) } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`

function absolutePath(value, windows) {
  if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) return false
  if (!windows) return posix.isAbsolute(value) && !value.startsWith('//')
  // Exclude drive-relative/root-relative paths, device namespaces and incomplete UNC.
  if (/^[A-Za-z]:[\\/]/.test(value)) return true
  if (/^[\\/]{2}[?.][\\/]/.test(value)) return false
  return /^[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(value)
}

function identity(value, windows) {
  return windows ? win32.normalize(value).toLowerCase() : posix.normalize(value)
}

function parseVersion(value, require7 = true) {
  if (typeof value !== 'string') return undefined
  // Windows PowerShell uses System.Version, e.g. 5.1.26100.1234, not SemVer.
  // Keep this branch out of 7+ parsing and sorting entirely.
  if (!require7 && /^5\.1\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value)) {
    const numbers = value.split('.').map(Number)
    return numbers.every(Number.isSafeInteger) ? { numbers } : undefined
  }
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value)
  if (!match) return undefined
  const numbers = match.slice(1, 4).map(Number)
  if (numbers.some((n) => !Number.isSafeInteger(n)) || numbers[0] < (require7 ? 7 : 5)) return undefined
  return { numbers, prerelease: match[4]?.split('.') }
}

// Stable beats any preview, then descending numeric SemVer (including prerelease identifiers).
function compareVersions(a, b) {
  if (!a.parsed.prerelease !== !b.parsed.prerelease) return a.parsed.prerelease ? 1 : -1
  for (let i = 0; i < 3; i++) {
    const difference = b.parsed.numbers[i] - a.parsed.numbers[i]
    if (difference) return difference
  }
  const left = a.parsed.prerelease ?? []
  const right = b.parsed.prerelease ?? []
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] === right[i]) continue
    if (left[i] === undefined) return 1
    if (right[i] === undefined) return -1
    const ln = /^\d+$/.test(left[i])
    const rn = /^\d+$/.test(right[i])
    if (ln && rn) return BigInt(left[i]) > BigInt(right[i]) ? -1 : 1
    if (ln !== rn) return ln ? 1 : -1
    return left[i] > right[i] ? -1 : 1
  }
  return 0
}

function parseProbe(stdout, windows, require7 = true) {
  if (typeof stdout !== 'string' || stdout.length > MAX_OUTPUT || stdout.includes('\0')) {
    throw new Error('invalid or excessive probe output')
  }
  const line = stdout.split(/\r?\n/).filter((s) => s.startsWith(MARKER)).at(-1)
  if (!line) throw new Error('probe marker missing')
  const data = JSON.parse(line.slice(MARKER.length))
  const parsed = parseVersion(data?.version, require7)
  if (require7) {
    if (!parsed || data?.edition !== 'Core') throw new Error('requires PowerShell >= 7 with PSEdition Core')
  } else {
    const core = parsed && data?.edition === 'Core' && parsed.numbers[0] >= 6 && parsed.numbers.length === 3
    const desktop = parsed && windows && data?.edition === 'Desktop' && parsed.numbers[0] === 5 && parsed.numbers[1] === 1 && !parsed.prerelease && !data.version.includes('+')
    if (!core && !desktop) throw new Error('invalid default PowerShell version or PSEdition (Core >= 6 or Windows Desktop 5.1 required)')
  }
  if (!absolutePath(data.path, windows)) throw new Error('process executable path is not a safe absolute path')
  return { path: data.path, version: data.version, edition: data.edition, parsed }
}

function defaultRunner(env) {
  return async (argv, timeout) => {
    const { stdout, stderr } = await execFileAsync(argv[0], argv.slice(1), {
      encoding: 'utf8', timeout, maxBuffer: MAX_OUTPUT, windowsHide: true, env,
    })
    if (stderr) throw new Error('subprocess emitted stderr')
    return stdout
  }
}

async function probeCandidate(candidate, { windows, run, resolvePath, timeoutMs, require7 = true }) {
  if (!absolutePath(candidate, windows)) throw new Error('invalid candidate path')
  if (!windows) candidate = await resolvePath(candidate)
  if (!absolutePath(candidate, windows)) throw new Error('resolved executable path is not absolute')
  let verified = parseProbe(await run([candidate, ...FLAGS, PROBE], timeoutMs), windows, require7)
  if (!windows) {
    const actual = await resolvePath(verified.path)
    if (!absolutePath(actual, false)) throw new Error('resolved process path is not absolute')
    verified.path = actual
  }
  // A Store alias, symlink or wrapper may launch another executable. Verify that exact binding.
  if (identity(candidate, windows) !== identity(verified.path, windows)) {
    const bound = parseProbe(await run([verified.path, ...FLAGS, PROBE], timeoutMs), windows, require7)
    const actual = windows ? bound.path : await resolvePath(bound.path)
    if (!absolutePath(actual, windows) || identity(actual, windows) !== identity(verified.path, windows)) {
      throw new Error('process executable identity changed during binding')
    }
    verified = { ...bound, path: actual }
  }
  return verified
}

function environmentValue(env, name) {
  const key = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : env[key]
}

async function windowsCandidates(env, run, readDir, timeoutMs) {
  const paths = []
  const add = (value) => { if (absolutePath(value, true)) paths.push(value) }
  const drive = environmentValue(env, 'SystemDrive') || 'C:'
  const programRoots = new Set([
    environmentValue(env, 'ProgramW6432'), environmentValue(env, 'ProgramFiles'),
    environmentValue(env, 'ProgramFiles(x86)'), `${drive}\\Program Files`, `${drive}\\Program Files (x86)`,
  ].filter((value) => absolutePath(value, true)))
  const local = environmentValue(env, 'LOCALAPPDATA')
  const roots = [...programRoots].map((root) => win32.join(root, 'PowerShell'))
  if (absolutePath(local, true)) roots.push(win32.join(local, 'Programs', 'PowerShell'), win32.join(local, 'Microsoft', 'PowerShell'))
  const children = async (root) => {
    try {
      return (await readDir(root)).filter((name) => typeof name === 'string' && name && !/[\\/\0]/.test(name))
    } catch { return [] }
  }
  for (const root of roots) {
    add(win32.join(root, '7', 'pwsh.exe'))
    add(win32.join(root, '7-preview', 'pwsh.exe'))
    for (const name of await children(root)) if (/^7/i.test(name)) add(win32.join(root, name, 'pwsh.exe'))
  }
  const appsRoots = [...programRoots].map((root) => win32.join(root, 'WindowsApps'))
  if (absolutePath(local, true)) {
    const aliases = win32.join(local, 'Microsoft', 'WindowsApps')
    add(win32.join(aliases, 'pwsh.exe'))
    appsRoots.push(aliases)
  }
  for (const root of appsRoots) {
    for (const name of await children(root)) {
      if (/^Microsoft\.PowerShell(?:Preview)?_7/i.test(name)) add(win32.join(root, name, 'pwsh.exe'))
    }
  }
  const systemRoot = environmentValue(env, 'SystemRoot')
  const where = absolutePath(systemRoot, true) ? win32.join(systemRoot, 'System32', 'where.exe') : 'where.exe'
  try {
    const output = await run([where, 'pwsh.exe'], timeoutMs)
    if (typeof output === 'string' && output.length <= MAX_OUTPUT) {
      for (const line of output.split(/\r?\n/)) add(line.trim())
    }
  } catch { /* PATH discovery is optional; explicit absolute installation candidates remain. */ }
  return paths
}

/**
 * Resolve and bind a verified PowerShell 7+ executable. Never executes powershell.exe as a fallback.
 *
 * run(argv, timeoutMs) -> Promise<string>: must reject spawn errors, nonzero exits, timeouts,
 * and stderr; default execFile uses UTF-8, 64 KiB maxBuffer, no shell, and the supplied env.
 * readDir(absoluteDir) -> Promise<string[]> and resolvePath(absolutePath) -> Promise<string>
 * are optional filesystem seams for hermetic tests (defaults: Node readdir / realpath).
 *
 * pinnedPath, when supplied, must be absolute and is the ONLY candidate; failure is unavailable.
 * Native Linux/macOS discover through /bin/sh `command -v pwsh` and Node realpath. No WSL
 * launch or automatic Windows interop: returned windowsInterop is false for these native paths.
 *
 * runtime.argv ends in -Command: append exactly one script string and execute this array directly.
 * A failed/stale binding MUST be reported by its caller, never retried via PATH or Windows 5.1.
 * timeoutMs is per subprocess, not an overall discovery deadline. Unavailability is not thrown.
 * @returns {Promise<{runtime: undefined|{label:string,path:string,version:string,argv:string[],windowsInterop:boolean},warning?:string}>}
 */
export async function detectPowerShell7({
  platform = process.platform,
  timeoutMs = 10000,
  pinnedPath,
  env = process.env,
  run,
  readDir = readdir,
  resolvePath = realpath,
} = {}) {
  const unavailable = (reason) => ({ runtime: undefined, warning: `PowerShell 7 unavailable: ${reason}` })
  const windows = platform === 'win32'
  if (!windows && platform !== 'linux' && platform !== 'darwin') return unavailable(`unsupported platform ${String(platform)}`)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) return unavailable('invalid timeoutMs')
  if (!env || typeof env !== 'object' || Array.isArray(env)) return unavailable('invalid env')
  if (run === undefined) run = defaultRunner(env)
  if (typeof run !== 'function' || typeof readDir !== 'function' || typeof resolvePath !== 'function') return unavailable('invalid discovery adapters')
  const pinned = pinnedPath !== undefined
  if (pinned && !absolutePath(pinnedPath, windows)) return unavailable('pinnedPath must be an absolute executable path without NUL or newlines')
  let candidates
  try {
    if (pinned) candidates = [pinnedPath]
    else if (windows) candidates = await windowsCandidates(env, run, readDir, timeoutMs)
    else {
      const found = await run(['/bin/sh', '-c', 'command -v pwsh'], timeoutMs)
      if (typeof found !== 'string' || found.length > MAX_OUTPUT) return unavailable('invalid command -v output')
      // command -v may describe aliases/functions; only one absolute filesystem path is usable.
      const lines = found.trim().split(/\r?\n/)
      candidates = lines.length === 1 && absolutePath(lines[0], false) ? lines : []
    }
  } catch { return unavailable('candidate discovery failed') }
  const valid = []
  const seen = new Set()
  let lastError = 'no verified PowerShell 7 Core executable found'
  for (let candidate of candidates) {
    try {
      if (!absolutePath(candidate, windows)) throw new Error('invalid candidate path')
      if (seen.has(identity(candidate, windows))) continue
      seen.add(identity(candidate, windows))
      valid.push(await probeCandidate(candidate, { windows, run, resolvePath, timeoutMs }))
    } catch (error) {
      lastError = String(error?.message ?? 'probe failed').replace(/[\0\r\n]/g, ' ').slice(0, 240)
    }
  }
  if (!valid.length) return unavailable(`${pinned ? 'pinnedPath rejected; no fallback: ' : ''}${lastError}`)
  valid.sort(compareVersions)
  const selected = valid[0]
  return {
    runtime: {
      label: `PowerShell ${selected.version} (Core)`,
      path: selected.path,
      version: selected.version,
      argv: [selected.path, ...FLAGS],
      windowsInterop: false,
    },
  }
}

/**
 * Prefer detectPowerShell7; only when it is unavailable discover the platform default.
 * The same run/readDir/resolvePath adapters and subprocess safety contract apply.
 * Windows defaults: where.exe pwsh.exe, then where.exe powershell.exe, then the
 * SystemRoot System32 WindowsPowerShell v1.0 executable. Native Linux/macOS use
 * command -v pwsh and realpath (Core 6 is permitted); no Windows/WSL interop.
 * Every default is version/edition/process-path probed and bound to an absolute argv.
 * A redirected process path must pass a second identity probe before binding.
 *
 * An explicit pinnedPath opts out of ALL fallback and still requires Core >= 7;
 * pinning Windows PowerShell 5.1 is intentionally rejected, not silently replaced.
 * isFallback and warning describe discovery, NOT an execution retry policy:
 * callers must execute runtime.argv directly and report a stale/failed binding.
 * No PATH lookup or fallback is allowed at execution time.
 * @returns {Promise<{runtime: undefined|{label:string,path:string,version:string,argv:string[],windowsInterop:boolean,isFallback:boolean},warning?:string}>}
 */
export async function detectPowerShellRuntime({
  platform = process.platform,
  timeoutMs = 10000,
  pinnedPath,
  env = process.env,
  run,
  readDir = readdir,
  resolvePath = realpath,
} = {}) {
  const preferred = await detectPowerShell7({ platform, timeoutMs, pinnedPath, env, run, readDir, resolvePath })
  if (preferred.runtime) return { ...preferred, runtime: { ...preferred.runtime, isFallback: false } }
  // Invalid configuration is not evidence that a different executable is safe.
  if (pinnedPath !== undefined || !['win32', 'linux', 'darwin'].includes(platform) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647 ||
      !env || typeof env !== 'object' || Array.isArray(env) ||
      (run !== undefined && typeof run !== 'function') ||
      typeof readDir !== 'function' || typeof resolvePath !== 'function') return preferred

  const windows = platform === 'win32'
  run ??= defaultRunner(env)
  const candidates = []
  const add = (path) => { if (absolutePath(path, windows)) candidates.push(path) }
  let lastError = 'no verified default PowerShell executable found'
  const remember = (error) => {
    lastError = String(error?.message ?? 'default probe failed').replace(/[\0\r\n]/g, ' ').slice(0, 240)
  }
  if (windows) {
    const root = environmentValue(env, 'SystemRoot')
    const where = absolutePath(root, true) ? win32.join(root, 'System32', 'where.exe') : 'where.exe'
    for (const executable of ['pwsh.exe', 'powershell.exe']) {
      try {
        const found = await run([where, executable], timeoutMs)
        if (typeof found !== 'string' || found.length > MAX_OUTPUT || found.includes('\0')) throw new Error('invalid where.exe output')
        for (const line of found.split(/\r?\n/)) add(line.trim())
      } catch (error) { remember(error) }
    }
    if (absolutePath(root, true)) add(win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  } else {
    try {
      const found = await run(['/bin/sh', '-c', 'command -v pwsh'], timeoutMs)
      if (typeof found !== 'string' || found.length > MAX_OUTPUT || found.includes('\0')) throw new Error('invalid command -v output')
      const lines = found.trim().split(/\r?\n/)
      if (lines.length === 1) add(lines[0])
    } catch (error) { remember(error) }
  }
  const seen = new Set()
  for (const candidate of candidates) {
    if (seen.has(identity(candidate, windows))) continue
    seen.add(identity(candidate, windows))
    try {
      const selected = await probeCandidate(candidate, { windows, run, resolvePath, timeoutMs, require7: false })
      return {
        runtime: {
          label: `PowerShell ${selected.version} (${selected.edition}; default fallback)`,
          path: selected.path,
          version: selected.version,
          argv: [selected.path, ...FLAGS],
          windowsInterop: false,
          isFallback: true,
        },
        warning: `${preferred.warning}; using default fallback PowerShell ${selected.version} (${selected.edition}), bound to ${selected.path}. Execution must not retry or fallback.`,
      }
    } catch (error) { remember(error) }
  }
  return { runtime: undefined, warning: `${preferred.warning}; default PowerShell unavailable: ${lastError}` }
}
