/**
 * Fail-closed shell workdir planning. No filesystem probes, subprocesses, or
 * fallback directories: a valid-looking but nonexistent path must fail at spawn/cd.
 */

function stringWithoutNul(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
  if (value.includes('\0')) throw new TypeError(`${label} must not contain NUL`)
  if (!allowEmpty && value.length === 0) throw new TypeError(`${label} must not be empty`)
  return value
}

/** Only undefined means omitted; invalid explicit/session values never fall back. */
export function resolveWorkdir(explicit, sessionCwd) {
  return stringWithoutNul(
    explicit !== undefined ? explicit : sessionCwd !== undefined ? sessionCwd : process.cwd(),
    'workdir',
  )
}

function isWindowsDriveAbsolute(value) {
  return /^[A-Za-z]:[\\/]/.test(value)
}

/** Return a slash-spelled UNC, or null. Reject device paths and incomplete UNC. */
function uncPath(value) {
  if (!/^[\\/]{2}/.test(value)) return null
  const normalized = value.replace(/\\/g, '/')
  const match = /^\/\/([^/]+)\/([^/]+)(\/[^]*)?$/.exec(normalized)
  if (!match) throw new TypeError('workdir must be a complete UNC host/share path')
  const [, host, share, rest = ''] = match
  if ([host, share].some((part) => part === '.' || part === '..' || /[:?*"<>|]/.test(part))) {
    throw new TypeError('workdir device/invalid UNC paths are not supported')
  }
  const canonicalHost = /^(?:wsl\.localhost|wsl\$)$/i.test(host) ? 'wsl.localhost' : host
  return `//${canonicalHost}/${share}${rest}`
}

/**
 * Windows Git Bash backend: {cwd} goes to spawn; {cd} must be used with
 * gitbashCommand and an explicit launcher cwd (process.cwd() is suitable).
 * UNC paths are entered by Bash, not silently substituted with SystemRoot.
 */
export function gitbashWorkdirPlan(workdir, defaultDistro) {
  stringWithoutNul(workdir, 'workdir')
  if (isWindowsDriveAbsolute(workdir)) return { cwd: workdir }
  const unc = uncPath(workdir)
  if (unc !== null) return { cd: unc }
  if (/^\/[A-Za-z](?:\/|$)/.test(workdir)) return { cd: workdir }
  if (workdir.startsWith('/')) {
    stringWithoutNul(defaultDistro, 'defaultDistro for a Linux workdir')
    if (/[\\/]/.test(defaultDistro) || defaultDistro === '.' || defaultDistro === '..' || /[:?*"<>|]/.test(defaultDistro)) {
      throw new TypeError('defaultDistro must be a single valid UNC share name')
    }
    return { cd: `//wsl.localhost/${defaultDistro}${workdir}` }
  }
  throw new TypeError('workdir must be an absolute Windows, UNC, MSYS, or Linux path')
}

/** One literal POSIX shell argument, including empty strings and embedded quotes. */
export function quoteShellArg(value) {
  stringWithoutNul(value, 'shell argument', { allowEmpty: true })
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

/** Never run the requested command after a failed directory change. */
export function gitbashCommand(command, cd) {
  stringWithoutNul(command, 'command', { allowEmpty: true })
  if (cd === undefined) return command
  stringWithoutNul(cd, 'cd')
  return `cd -- ${quoteShellArg(cd)} || exit 1; ${command}`
}

/**
 * Return {cwd} for the selected PowerShell backend; never infer Windows from a
 * Linux-looking path. windowsInterop means a Windows .exe backend on Linux,
 * not simply "running inside WSL". Windows paths on such hosts may fail spawn;
 * this helper intentionally does not translate them or fall back on failure.
 */
export function pwshWorkdirPlan(workdir, { platform = process.platform, windowsInterop = false } = {}) {
  stringWithoutNul(workdir, 'workdir')
  stringWithoutNul(platform, 'platform')
  if (typeof windowsInterop !== 'boolean') throw new TypeError('windowsInterop must be a boolean')
  if (platform === 'win32' || windowsInterop) {
    if (isWindowsDriveAbsolute(workdir)) return { cwd: workdir }
    if (uncPath(workdir) !== null) return { cwd: workdir }
    throw new TypeError('Windows PowerShell workdir must be an absolute Windows drive or UNC path')
  }
  if (workdir.startsWith('/') && !workdir.startsWith('//')) return { cwd: workdir }
  throw new TypeError('native PowerShell workdir must be an absolute POSIX path')
}
