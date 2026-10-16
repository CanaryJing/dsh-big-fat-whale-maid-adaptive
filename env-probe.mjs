/**
 * Environment awareness and host shell tools for the whale-maid preset.
 * Cached host facts are contributed as a system section on EVERY request;
 * DSH interpolates the final request model/provider only at prompt rendering.
 * No durable user-message injection or once-per-process history IDs are used.
 * Detection failure is reported as unknown; shell workdir errors fail closed.
 * Only Node built-ins and bundled helpers are required.
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { registerEnvironmentContext } from './environment-context.mjs'
import { detectPowerShellRuntime, powerShellCommand } from './powershell-runtime.mjs'
import { gitbashCommand, gitbashWorkdirPlan, pwshWorkdirPlan, resolveWorkdir } from './shell-workdir.mjs'
import { arch, cpus, homedir, hostname, release, tmpdir, totalmem, userInfo, version as osVersion } from 'node:os'

const execFileAsync = promisify(execFile)

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'whale-maid-env-probe'

/** 工具注册需要 tools；pwsh-linux 工具执行与冒烟测试需要 subprocess。 */
export const inject = ['tools', 'subprocess', 'systemPrompt']

const UNC_HOSTS = ['wsl.localhost', 'wsl$']
const LXSS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss'
const DEFAULT_TIMEOUT_MS = 10000

// ── 路径世界判定（与 dsh-wsl-workspace 相同的形状规则）──────────────────────

/** 解析 \\wsl.localhost\<distro>\… / \\wsl$\<distro>\…（含正斜杠拼写）。 */
function parseWslUnc(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null
  const normalized = raw.replace(/\\/g, '/').replace(/\/\/+/g, '//')
  if (!normalized.startsWith('//')) return null
  const segments = normalized.slice(2).split('/')
  const host = (segments[0] ?? '').toLowerCase()
  if (!UNC_HOSTS.includes(host)) return null
  const distro = segments[1] ?? ''
  if (distro === '') return null
  const linuxPath = `/${segments.slice(2).filter((s) => s.length > 0).join('/')}`
  return { distro, linuxPath }
}

function isAbsoluteLinuxPath(path) {
  return typeof path === 'string' && path.startsWith('/') && !path.includes('\0')
}

function isWindowsDrivePath(path) {
  return typeof path === 'string' && /^[A-Za-z]:[\\/]/.test(path)
}

/** Windows 盘符路径 → /mnt/<drive>/…（仅 drvfs 约定挂载点）。 */
function windowsToMntPath(path) {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(path ?? '')
  if (match === null) return null
  const rest = (match[2] ?? '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '')
  return `/mnt/${(match[1] ?? '').toLowerCase()}${rest === '' ? '' : `/${rest}`}`
}

/** Linux 绝对路径 → WSL UNC（\\wsl.localhost\<distro>\…）。 */
function linuxToUnc(distro, linuxPath) {
  if (!isAbsoluteLinuxPath(linuxPath)) return null
  const normalized = linuxPath.replace(/\/+/g, '/').replace(/\/$/, '')
  const segments = (normalized.startsWith('/') ? normalized.slice(1) : normalized).replace(/\//g, '\\')
  return `\\\\wsl.localhost\\${distro}${segments === '' ? '' : `\\${segments}`}`
}

/**
 * 判定一个工作目录属于哪个世界。
 * @returns {{ world: 'wsl'|'linux'|'windows'|'unknown', label: string, [key: string]: unknown }}
 */
export function worldOf(cwd) {
  const raw = typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
  const unc = parseWslUnc(raw)
  if (unc !== null) {
    return {
      world: 'wsl',
      label: 'WSL fs',
      distro: unc.distro,
      linuxPath: unc.linuxPath,
      raw,
    }
  }
  if (isAbsoluteLinuxPath(raw)) {
    return { world: 'linux', label: 'native Linux fs', linuxPath: raw, raw }
  }
  if (isWindowsDrivePath(raw)) {
    return {
      world: 'windows',
      label: 'Windows fs',
      path: raw,
      mntPath: windowsToMntPath(raw),
      raw,
    }
  }
  return { world: 'unknown', label: 'unknown', raw }
}

// ── 探测辅助（全部异步，绝不阻塞事件循环）───────────────────────────────────

function decodeExecOutput(buffer) {
  if (buffer === undefined || buffer === null) return ''
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  return buf.includes(0) ? buf.toString('utf16le') : buf.toString('utf8')
}

async function execCapture(argv, timeoutMs, options = {}) {
  const { stdout } = await execFileAsync(argv[0], argv.slice(1), {
    encoding: 'buffer',
    timeout: timeoutMs,
    windowsHide: true,
    ...options,
  })
  return decodeExecOutput(stdout)
}

async function tryCapture(fn) {
  try {
    const text = await fn()
    return typeof text === 'string' ? text.trim() : ''
  } catch {
    return ''
  }
}

/** 列出已安装的 WSL 发行版（wsl.exe -l -q）。 */
async function listDistros(timeoutMs) {
  const text = await tryCapture(() => execCapture(['wsl.exe', '-l', '-q'], timeoutMs))
  return text.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0 && !s.includes('\0'))
}

/** 读取用户默认发行版（Lxss 注册表；失败返回 undefined）。 */
async function defaultDistro(timeoutMs) {
  const text = await tryCapture(() => execCapture(['reg.exe', 'query', LXSS_KEY, '/v', 'DefaultDistribution'], timeoutMs))
  const guid = /DefaultDistribution\s+REG_SZ\s+(\{[0-9a-fA-F-]+\})/i.exec(text)?.[1]
  if (guid === undefined) return undefined
  const name = await tryCapture(() => execCapture(['reg.exe', 'query', `${LXSS_KEY}\\${guid}`, '/v', 'DistributionName'], timeoutMs))
  const distro = /DistributionName\s+REG_SZ\s+(.+)/i.exec(name)?.[1]?.trim()
  return distro === undefined || distro === '' ? undefined : distro
}

/** Linux 上探测某个可执行文件在 PATH 中的路径。 */
async function linuxWhich(cmd) {
  const text = await tryCapture(() => execCapture(['bash', '-lc', `command -v ${cmd} || true`], 8000))
  const first = text.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0)
  return first === undefined || first === '' ? undefined : first
}

/**
 * Windows 母系统 Git Bash 探测（win32 专用）：按常见安装位置枚举——
 * Program Files、Program Files (x86)、每用户 Programs。Git Bash 是 Windows
 * 侧默认 shell，探测失败时 Windows 侧回退到 pwsh。
 */
function detectGitBash() {
  const programFiles = process.env.ProgramFiles
  const programFilesX86 = process.env['ProgramFiles(x86)']
  const localAppData = process.env.LOCALAPPDATA
  const candidates = []
  const push = (label, path) => {
    if (typeof path === 'string' && path.length > 0) {
      candidates.push({ label, path })
    }
  }
  if (typeof programFiles === 'string' && programFiles.length > 0) {
    push('Git Bash (Program Files)', `${programFiles}\\Git\\bin\\bash.exe`)
  }
  if (typeof programFilesX86 === 'string' && programFilesX86.length > 0) {
    push('Git Bash (Program Files x86)', `${programFilesX86}\\Git\\bin\\bash.exe`)
  }
  if (typeof localAppData === 'string' && localAppData.length > 0) {
    push('Git Bash (per-user)', `${localAppData}\\Programs\\Git\\bin\\bash.exe`)
  }
  const seen = new Set()
  for (const cand of candidates) {
    if (seen.has(cand.path)) continue
    seen.add(cand.path)
    try {
      if (existsSync(cand.path)) {
        return { label: cand.label, argv: [cand.path, '-lc'] }
      }
    } catch {
      // 路径含非法字符等极端情况：跳过该候选。
    }
  }
  return undefined
}

/** 是否运行在 WSL 发行版内部（Linux 内核 + Microsoft 标记）。 */
function detectInsideWsl() {
  if (process.platform !== 'linux') return false
  if (process.env.WSL_DISTRO_NAME !== undefined && process.env.WSL_DISTRO_NAME !== '') return true
  try {
    const version = readFileSync('/proc/version', 'utf8')
    return /microsoft|wsl/i.test(version)
  } catch {
    return false
  }
}

/**
 * 静态环境快照（异步探测）。env_probe 工具每次调用时重新探测；挂载时探测
 * 一次供简报使用。任何一项失败都降级，绝不抛错。
 * @returns {Promise<object>} snapshot
 */
export async function probeStatic(timeoutMs, options = {}) {
  const platform = process.platform
  const insideWsl = detectInsideWsl()
  const snapshot = {
    probedAt: Date.now(),
    platform,
    platformLabel:
      platform === 'win32' ? 'native Windows'
      : platform === 'linux' && insideWsl ? 'inside WSL (Linux on Windows)'
      : platform === 'linux' ? 'native Linux'
      : platform === 'darwin' ? 'macOS'
      : platform === 'android' ? 'Android'
      : String(platform),
    insideWsl,
    system: undefined,
    wsl: { installed: false, distros: [], defaultDistro: undefined },
    gitbash: undefined, // { label, argv } Git Bash 后端（win32=Windows 母系统；全环境第一优先 shell）
    pwsh: undefined, // { label, argv } 可用 PowerShell 后端（win32=Windows 母系统；非 win32=跨到 Windows 的 interop）
    wine: undefined,
  }
  // 系统环境事实（node:os 打底 + 平台差异探测）：供简报的系统环境报告使用。
  snapshot.system = await systemInfo(platform, insideWsl, timeoutMs)

  if (platform === 'win32') {
    const distros = await listDistros(timeoutMs)
    snapshot.wsl = {
      installed: distros.length > 0,
      distros,
      defaultDistro: (await defaultDistro(timeoutMs)) ?? distros[0],
    }
    // Windows 母系统 Git Bash：全环境第一优先 shell；探测失败则回退 pwsh。
    snapshot.gitbash = detectGitBash()
  } else {
    const wine = await linuxWhich('wine')
    if (wine !== undefined) snapshot.wine = { path: wine }
  }
  // Only discovery may choose the default backend when no PowerShell 7 exists.
  // Once registered, execute the exact verified path; never retry via 5.1/PATH.
  const powershell = await detectPowerShellRuntime({
    platform, timeoutMs, pinnedPath: options.pwshPath,
  })
  snapshot.pwsh = powershell.runtime
  snapshot.pwshWarning = powershell.warning
  return snapshot
}

// ── 简报生成 ───────────────────────────────────────────────────────────────

/** 读取 Linux /etc/os-release 的 PRETTY_NAME；失败返回 undefined。 */
function readOsRelease() {
  try {
    const text = readFileSync('/etc/os-release', 'utf8')
    const match = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(text)
    return match !== null ? match[1] : undefined
  } catch {
    return undefined
  }
}

/** 运行一条命令并取第一行非空输出；失败/超时/无命令一律返回 undefined。 */
async function firstLine(argv, timeoutMs) {
  try {
    const text = await execCapture(argv, timeoutMs)
    return String(text).split('\n').map((line) => line.trim()).find((line) => line.length > 0)
  } catch {
    return undefined
  }
}

/**
 * 系统环境事实：node:os 打底，按平台补充 OS 名称——
 * win32 = os.version()；darwin = sw_vers；android = getprop；
 * 其余（Linux / WSL / BSD 等）= /etc/os-release，回退 uname -sr。
 * 任何一步失败都降级为 undefined，绝不抛错。
 */
async function systemInfo(platform, insideWsl, timeoutMs) {
  const timeout = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 5000
  let username
  try { username = userInfo().username } catch { username = undefined }
  const info = {
    os: undefined,
    kernel: release(),
    arch: arch(),
    hostname: hostname(),
    username,
    home: homedir(),
    tmp: tmpdir(),
    cpu: String(cpus()[0]?.model ?? '').trim().replace(/\s+/g, ' '),
    threads: cpus().length,
    memGB: Math.round(totalmem() / 1073741824),
    insideWsl,
    distro: undefined,
  }
  if (platform === 'win32') {
    info.os = osVersion() || `Windows ${release()}`
    return info
  }
  if (platform === 'darwin') {
    const version = await firstLine(['sw_vers', '-productVersion'], timeout)
    info.os = version !== undefined ? `macOS ${version}` : `macOS (Darwin ${release()})`
    return info
  }
  if (platform === 'android') {
    const [androidVersion, sdk, model] = await Promise.all([
      firstLine(['getprop', 'ro.build.version.release'], timeout),
      firstLine(['getprop', 'ro.build.version.sdk'], timeout),
      firstLine(['getprop', 'ro.product.model'], timeout),
    ])
    const parts = ['Android']
    if (androidVersion !== undefined) parts.push(androidVersion)
    else {
      const fallback = readOsRelease()
      if (fallback !== undefined) parts.push(fallback)
    }
    if (sdk !== undefined) parts.push(`API ${sdk}`)
    if (model !== undefined) parts.push(model)
    info.os = parts.join(' ')
    return info
  }
  info.distro = readOsRelease()
  if (info.distro === undefined) {
    const uname = await firstLine(['uname', '-sr'], timeout)
    if (uname !== undefined) info.distro = uname
  }
  return info
}

/**
 * shell 路由摘要（紧凑单行）。`wslVariant` 为 true 表示本预设以 `wsl-*` 变体
 * 运行（bash/文件工具由 dsh-wsl-workspace 提供，执行世界是 WSL）。
 */
function shellSummary(snapshot, world, wslVariant = false) {
  if (snapshot.platform === 'win32') {
    const distro = world.world === 'wsl' ? world.distro : (snapshot.wsl.defaultDistro ?? '<distro>')
    const distros = (snapshot.wsl.installed && snapshot.wsl.distros.length > 0)
      ? ` (distros ${snapshot.wsl.distros.map((d) => (d === snapshot.wsl.defaultDistro ? `${d}*` : d)).join(', ')})`
      : ''
    const bash = !wslVariant && !snapshot.wsl?.installed
      ? 'bash [unavailable: no WSL distribution detected]'
      : wslVariant
      ? `bash -> WSL "${distro}" Linux bash (dsh-wsl-workspace; Linux-only work)`
      : `bash -> WSL "${distro}" Linux bash (native Linux paths; Linux-only work)`
    const parts = [
      snapshot.gitbash !== undefined ? `gitbash [FIRST] ${snapshot.gitbash.label}` : 'gitbash [missing]',
      snapshot.pwsh !== undefined
        ? `pwsh [${snapshot.gitbash !== undefined ? 'fallback' : 'first'}] ${snapshot.pwsh.label}`
        : 'pwsh [missing]',
      bash + distros,
    ]
    return parts.join(' · ')
  }
  const parts = ['bash [native]']
  if (snapshot.pwsh !== undefined) parts.push(`pwsh [optional] ${snapshot.pwsh.label}`)
  return parts.join(' · ')
}

/** 文件工具与搜索的世界路由摘要（紧凑单行）。 */
function fileSummary(snapshot, wslVariant = false) {
  if (snapshot.platform === 'win32') {
    return wslVariant
      ? 'read/write/edit/str_replace_editor on WSL fs world (Linux paths; Windows files via /mnt/<drive>); glob/grep via find/grep'
      : 'read/write/edit/str_replace_editor on host fs (Windows paths + \\\\wsl.localhost\\<distro>\\…); no glob/grep on win32 -> gitbash find/grep'
  }
  return 'read/write/edit/glob/grep on the native filesystem'
}

function pathRules(snapshot, world) {
  const lines = []
  if (snapshot.platform === 'win32') {
    const distro = world.world === 'wsl' ? world.distro : (snapshot.wsl.defaultDistro ?? '<distro>')
    lines.push(`WSL->Win: /home/<user>/x = \\\\wsl.localhost\\${distro}\\home\\<user>\\x`)
    lines.push('Win->WSL: C:\\Users\\<user>\\x = /mnt/c/Users/<user>/x')
    lines.push('bash on Windows files (Linux tools only): /mnt/<drive>/…; gitbash/pwsh on WSL files: \\\\wsl.localhost\\<distro>\\…')
  } else if (snapshot.insideWsl) {
    lines.push('Win->WSL: C:\\Users\\<user>\\x = /mnt/c/Users/<user>/x')
    lines.push('WSL->Win: /home/<user>/x = \\\\wsl.localhost\\<distro>\\home\\<user>\\x')
    lines.push('bash on Windows files (Linux tools only): /mnt/<drive>/…; Windows executables require WSL interop; native pwsh remains Linux-side.')
  } else {
    lines.push('single world: no cross-system path conversion')
    if (snapshot.wine !== undefined) lines.push(`wine: ${snapshot.wine.path} (Windows apps on Linux, prefix ~/.wine)`)
  }
  return lines
}

/**
 * 生成缓存系统环境报告（每次请求装配）。报告宿主系统（OS / 内核 / 架构）、
 * 硬件概要（CPU / 线程 / 内存）、用户与 home/tmp、cwd 所属世界、可用 shell
 * 与路径互转规则；`wslVariant` 为 true 时按 `wsl-*` 变体的执行世界描述。
 */
export function buildBrief(snapshot, cwd, wslVariant = false) {
  const world = worldOf(cwd)
  const sys = snapshot.system ?? {}
  const lines = ['[ENV] whale-maid auto-probe']

  const host = [`${snapshot.platformLabel} (${snapshot.platform})`]
  const osName = sys.os ?? sys.distro
  if (osName) host.push(osName)
  if (sys.kernel) host.push(snapshot.platform === 'win32' ? sys.kernel : `kernel ${sys.kernel}`)
  if (sys.arch) host.push(sys.arch)
  lines.push(`host: ${host.join(' · ')}`)

  const hardware = []
  if (sys.cpu) hardware.push(sys.cpu)
  if (sys.threads) hardware.push(`${sys.threads} threads`)
  if (sys.memGB) hardware.push(`${sys.memGB} GB RAM`)
  if (hardware.length > 0) lines.push(`hw: ${hardware.join(' · ')}`)

  const user = []
  if (sys.username !== undefined || sys.hostname !== undefined) {
    user.push([sys.username, sys.hostname].filter(Boolean).join(' @ '))
  }
  if (sys.home) user.push(`home ${sys.home}`)
  if (sys.tmp) user.push(`tmp ${sys.tmp}`)
  if (user.length > 0) lines.push(`user: ${user.join(' · ')}`)

  const cwdLabel = (world.world === 'linux' && snapshot.platform !== 'linux')
    ? `${snapshot.platformLabel} fs`
    : world.label
  lines.push(`cwd: ${world.raw} (${cwdLabel})`)
  lines.push(`shells: ${shellSummary(snapshot, world, wslVariant)}`)
  lines.push(`files: ${fileSummary(snapshot, wslVariant)}`)
  lines.push('paths:')
  for (const rule of pathRules(snapshot, world)) lines.push(`  ${rule}`)
  if (snapshot.pwsh) lines.push(`pwsh binding: ${snapshot.pwsh.path} (version ${snapshot.pwsh.version}; ${snapshot.pwsh.isFallback ? 'system-default fallback; no PowerShell 7 available' : 'verified PowerShell 7+'})`)
  if (snapshot.pwshWarning) lines.push(`pwsh notice: ${snapshot.pwshWarning}`)
  lines.push('probe: PowerShell version/path verified when available; other shell candidates not execution-tested. env_probe refreshes facts and runs smoke tests (may start WSL).')
  if (Number.isFinite(snapshot.probedAt)) lines.push(`snapshot: ${new Date(snapshot.probedAt).toISOString()} (cached host facts; cwd is request-local)` )
  if (snapshot.probeError) lines.push(`probe warning: ${snapshot.probeError}`)
  return lines.join('\n')
}

// ── 冒烟测试（异步）──────────────────────────────────────────────────────────

async function smokeCapture(argv, timeoutMs) {
  try {
    const text = await execCapture(argv, timeoutMs)
    return text.length > 0 ? text.slice(0, 4000) : '(无输出，退出码 0)'
  } catch (error) {
    const detail = error && error.stdout ? `\nstdout: ${String(error.stdout).slice(0, 500)}` : ''
    return `FAILED: ${error && error.message ? error.message : String(error)}${detail}`
  }
}

/** 测试 bash 后端（Windows 宿主 → WSL bash；Linux 宿主 → 原生 bash）。 */
async function smokeBash(snapshot, timeoutMs) {
  if (snapshot.platform === 'win32') {
    const distro = snapshot.wsl.defaultDistro
    if (distro === undefined) return 'no WSL distro available, bash smoke test skipped'
    return smokeCapture(
      ['wsl.exe', '-d', distro, '-e', 'bash', '-lc', 'echo env_probe_bash_ok; uname -srm; echo shell=$0; pwd'],
      timeoutMs,
    )
  }
  return smokeCapture(['bash', '-lc', 'echo env_probe_bash_ok; uname -srm; echo shell=$0; pwd'], timeoutMs)
}

/** 测试 pwsh 后端（win32=Windows 母系统 PowerShell；非 win32=探测到的跨世界后端）。 */
async function smokePwsh(snapshot, timeoutMs) {
  if (snapshot.pwsh === undefined) return 'no PowerShell available, pwsh smoke test skipped'
  return smokeCapture(
    [...snapshot.pwsh.argv, powerShellCommand("'env_probe_pwsh_ok'; $PSVersionTable.PSVersion.ToString(); $env:OS")],
    timeoutMs,
  )
}

/** 测试 gitbash 后端（win32=Windows 母系统 Git Bash）。 */
async function smokeGitBash(snapshot, timeoutMs) {
  if (snapshot.gitbash === undefined) return 'gitbash not found, skipped'
  return smokeCapture(
    [...snapshot.gitbash.argv, 'echo env_probe_gitbash_ok; uname -srm; echo shell=$0; pwd'],
    timeoutMs,
  )
}

// ── 工具 schema 编译器（零依赖）────────────────────────────────────────────

function toJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, meta] of Object.entries(spec || {})) {
    const prop = { type: meta.type }
    if (meta.description) prop.description = meta.description
    properties[key] = prop
    if (meta.required) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

const textOutput = {
  schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
  render: (_args, value) => [{ type: 'text', text: value.text }],
}

// ── 插件主体 ───────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  const source = config === undefined || config === null ? {} : config
  const probeTimeoutMs =
    Number.isSafeInteger(source.probeTimeoutMs) && source.probeTimeoutMs > 0
      ? source.probeTimeoutMs
      : DEFAULT_TIMEOUT_MS

  // 是否为 dsh-wsl-workspace 生成的 `wsl-*` 变体（baseUrl 指向 wsl- 目录）。
  // 与 agent.cordis.yml 中 `/[\\/]wsl-/.test(baseUrl)` 自禁用用的是同一判定。
  const isWslVariant = typeof ctx.baseUrl === 'string' && /[\\/]wsl-/.test(ctx.baseUrl)

  // 挂载后异步探测一次：不阻塞启动；简报注入与 pwsh 注册都会等待它完成。
  let resolvedSnapshot = undefined
  const probePromise = probeStatic(probeTimeoutMs, source)
    .then((value) => {
      resolvedSnapshot = value
      return value
    })
    .catch((error) => {
      const fallback = {
        probedAt: Date.now(),
        platform: process.platform,
        platformLabel: String(process.platform),
        insideWsl: false,
        wsl: { installed: false, distros: [], defaultDistro: undefined },
        pwsh: undefined,
        wine: undefined,
        probeError: error && error.message ? error.message : String(error),
      }
      resolvedSnapshot = fallback
      return fallback
    })

  /** 重新探测（env_probe 工具每次调用时刷新；失败降级到最近一次快照）。 */
  const refresh = async () => {
    try {
      const fresh = await probeStatic(probeTimeoutMs, source)
      const mounted = await probePromise
      // Registered tools keep mount-time argv. Re-probing may discover a new
      // installation, but must not falsely claim the existing tool uses it.
      if (fresh.pwsh?.path !== mounted.pwsh?.path || fresh.pwsh?.version !== mounted.pwsh?.version) {
        fresh.pwshWarning = [fresh.pwshWarning,
          'Discovery changed; the registered pwsh binding remains unchanged. Reload the preset to rebind.',
        ].filter(Boolean).join(' ')
      }
      fresh.pwsh = mounted.pwsh
      resolvedSnapshot = fresh
      return fresh
    } catch (error) {
      const base = resolvedSnapshot ?? (await probePromise)
      resolvedSnapshot = {
        ...base,
        probeError: error && error.message ? error.message : String(error),
      }
      return resolvedSnapshot
    }
  }

  registerEnvironmentContext(ctx, {
    getSnapshot: () => resolvedSnapshot,
    ready: probePromise,
    describe: (snapshot, { agent }) => buildBrief(
      snapshot, agent.session?.header?.cwd ?? process.cwd(), isWslVariant,
    ),
  })

  // ── 2) env_probe 工具：复查环境 + 实测两侧 shell（全异步，不阻塞）──────
  ctx.effect(() => {
    ctx.tools.register({
      name: 'env_probe',
      description:
        'Refresh cached host facts (OS/kernel/arch, CPU/memory, user/home/tmp, cwd world, shell candidates and path rules), and smoke-test bash/gitbash/pwsh. The current model/provider routing IDs are supplied separately by the live system prompt. Smoke tests may start WSL.',
      parameters: toJsonSchema({}),
      output: textOutput,
      async execute(_args, exec) {
        const fresh = await refresh()
        const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd()
        const smokeTimeout = Math.max(probeTimeoutMs, 15000)
        const [bashTest, gitbashTest, pwshTest] = await Promise.all([
          smokeBash(fresh, smokeTimeout),
          smokeGitBash(fresh, smokeTimeout),
          smokePwsh(fresh, smokeTimeout),
        ])
        const wineLine = fresh.wine !== undefined
          ? `wine: ${fresh.wine.path} (Windows compat layer on Linux)`
          : 'wine: not found'
        const text = [
          buildBrief(fresh, cwd, isWslVariant),
          'model/provider: see [MODEL] in the current system prompt (live request route; not inferred from stale session options).',
          'smoke tests:',
          `bash: ${bashTest}`,
          `gitbash: ${gitbashTest}`,
          `pwsh: ${pwshTest}`,
          wineLine,
        ].join('\n')
        return { text }
      },
    })
  })

  // ── 3) 按探测结果注册 gitbash 工具（win32=Windows 母系统 Git Bash；全环境第一优先 shell）──
  ctx.effect(async () => {
    const snap = await probePromise
    if (snap.gitbash === undefined) return
    const gitbashArgv = snap.gitbash.argv
    const label = snap.gitbash.label
    ctx.tools.register({
      name: 'gitbash',
      description: [
        `Run commands in Git Bash on the Windows mother system. Backend: ${label}.`,
        'FIRST-CHOICE shell for EVERY environment: prefer it for Windows-side work (C:\\…), for WSL/Linux files via their //wsl.localhost/<distro>/… UNC form, and for general shell/Git/script tasks.',
        'Fall back to pwsh (PowerShell-only features or gitbash missing) or bash (Linux-only tooling, package managers, /proc, or gitbash missing) only when needed.',
        'Use it to operate the Windows host directly (files, Git, shell scripts, mingw toolchain, etc.).',
        'Each call runs a fresh bash -lc shell (state does NOT persist across calls).',
        'Windows paths are native here (C:\\…); inside the shell they appear as /c/… (MSYS2 style, NOT /mnt/c); WSL files are reachable as //wsl.localhost/<distro>/….',
        'Commands run in a fresh process; non-zero exit codes are reported as errors.',
      ].join('\n'),
      parameters: toJsonSchema({
        command: { type: 'string', required: true, description: 'The bash command to execute (bash -lc string domain, Windows world).' },
        workdir: {
          type: 'string',
          description:
            'Optional working directory. Windows drive paths (C:\\…) become the process cwd; ' +
            'WSL UNC paths (\\\\wsl.localhost\\<distro>\\…) and Linux absolute paths are entered with an automatic cd ' +
            '(Git Bash reaches WSL files through //wsl.localhost/<distro>/…). ' +
            'Omitted uses the session cwd; empty, relative or unsupported paths are rejected. A failed cd stops the command.',
        },
      }),
      output: textOutput,
      async execute(args, exec) {
        const workdir = resolveWorkdir(args.workdir, exec?.agent?.session?.header?.cwd)
        const plan = gitbashWorkdirPlan(workdir, snap.wsl?.defaultDistro)
        // A launcher cwd is not the execution directory: cd -- <quoted target>
        // must succeed before any caller command is allowed to run.
        const windowsCwd = plan.cwd ?? process.cwd()
        const command = gitbashCommand(args.command, plan.cd)
        const signal = exec?.signal
        const handle = ctx.subprocess.spawn({
          argv: [...gitbashArgv, command],
          ...(windowsCwd !== undefined ? { cwd: windowsCwd } : {}),
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: 64000 },
            stderr: { maxBytes: 64000 },
          },
          env: { NO_COLOR: '1', TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat' },
          ...(signal !== undefined ? { signal } : {}),
          graceMs: 3000,
        })
        let outcome
        try {
          outcome = await handle.done
        } catch (error) {
          throw new Error(`gitbash spawn failed: ${String(error)}`)
        }
        let stdout = ''
        let stderr = ''
        try {
          stdout = handle.collected.stdout.readFrom(0).text
          stderr = handle.collected.stderr.readFrom(0).text
        } catch {
          // 某些后端可能没有 collect 读取器，容忍。
        }
        const text = [stdout, stderr].filter((part) => part.length > 0).join('\n')
        const tail = text.length > 0 ? text : `exit code: ${outcome.exitCode} (no output)`
        if (outcome.exitCode !== 0) {
          throw new Error(tail)
        }
        return { text: tail }
      },
    })
  })

  // ── 4) 按探测结果注册 pwsh 工具（win32=Windows 母系统 PowerShell；非 win32=跨世界后端）──
  ctx.effect(async () => {
    const snap = await probePromise
    if (snap.pwsh === undefined) return
    const pwshArgv = snap.pwsh.argv
    const label = `${snap.pwsh.label}; executable=${snap.pwsh.path}; version=${snap.pwsh.version}`
    const description = snap.platform === 'win32'
      ? `Run a PowerShell command on the Windows mother system. Backend: ${label}. ` +
        (snap.gitbash !== undefined
          ? 'This is the FALLBACK shell: prefer the `gitbash` tool for ALL shell work; use pwsh only when Git Bash is unavailable or PowerShell-specific features (registry, services, WMI, etc.) are needed. '
          : 'This is the default shell for Windows-side file operations; prefer it over bash for Windows paths (C:\\…). ') +
        'Use it to operate the Windows host directly (registry, services, files, Git, etc.). ' +
        'Commands run in a fresh process; non-zero exit codes are reported as errors.'
      : `Run a PowerShell command. Backend: ${label}. ` +
        'Use it to reach the Windows mother system when running inside WSL (powershell.exe interop) ' +
        'or to drive PowerShell on native Linux. Commands run in a fresh process; non-zero exit codes are reported as errors.'
    ctx.tools.register({
      name: 'pwsh',
      description: description + ' This tool is bound to the verified absolute executable above. Prefer this tool for .ps1 scripts and Windows UI automation; do not launch powershell.exe or another unverified PowerShell through a different shell. PowerShell 7 is preferred; only when unavailable does discovery select the explicitly reported system-default backend. Command failures never trigger another fallback.',
      parameters: toJsonSchema({
        command: { type: 'string', required: true, description: 'The PowerShell command to execute.' },
        workdir: {
          type: 'string',
          description:
            'Optional absolute working directory. Windows/interop PowerShell accepts drive paths and UNC; ' +
            'native Linux/macOS PowerShell accepts native absolute paths. Omitted uses the session cwd; ' +
            'empty, relative or cross-world paths are rejected, never redirected to a system directory.',
        },
      }),
      output: textOutput,
      async execute(args, exec) {
        const workdir = resolveWorkdir(args.workdir, exec?.agent?.session?.header?.cwd)
        const { cwd: windowsCwd } = pwshWorkdirPlan(workdir, {
          platform: snap.platform,
          windowsInterop: /\.exe$/i.test(pwshArgv[0]),
        })
        const signal = exec?.signal
        const handle = ctx.subprocess.spawn({
          argv: [...pwshArgv, powerShellCommand(args.command)],
          ...(windowsCwd !== undefined ? { cwd: windowsCwd } : {}),
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: 64000 },
            stderr: { maxBytes: 64000 },
          },
          ...(signal !== undefined ? { signal } : {}),
          graceMs: 3000,
        })
        let outcome
        try {
          outcome = await handle.done
        } catch (error) {
          throw new Error(`pwsh spawn failed: ${String(error)}`)
        }
        let stdout = ''
        let stderr = ''
        try {
          stdout = handle.collected.stdout.readFrom(0).text
          stderr = handle.collected.stderr.readFrom(0).text
        } catch {
          // 某些后端可能没有 collect 读取器，容忍。
        }
        const text = [stdout, stderr].filter((part) => part.length > 0).join('\n')
        const tail = text.length > 0 ? text : `exit code: ${outcome.exitCode} (no output)`
        if (outcome.exitCode !== 0) {
          throw new Error(tail)
        }
        return { text: tail }
      },
    })
  })
}
