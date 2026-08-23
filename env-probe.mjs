/**
 * env-probe — 大肥鱼女仆长 · 环境自适应模式的环境探测与双世界 shell 路由。
 *
 * 职责：
 *   1. 探测静态环境（宿主平台、是否 WSL 内、WSL 发行版、pwsh/wine 可用性）；
 *   2. 每个会话第一次请求前注入一份「环境简报」，告诉模型 bash/pwsh/文件工具
 *      各自运行在哪个世界，以及两个世界之间的路径互转规则；
 *   3. 注册 env_probe 工具：随时复查环境，并实际冒烟测试两侧 shell；
 *   4. 按探测结果注册 pwsh 工具：win32 上为 Windows 母系统 PowerShell（优先
 *      pwsh.exe，兜底 powershell.exe）；非 Windows 宿主上为原生 Linux 的 pwsh
 *      或 WSL 内的 powershell.exe interop，让模型始终能触达 Windows 母系统。
 *
 * v3（2026-02 审查修复）：
 *   - P1：pwsh 工具的 workdir 做 Windows 世界翻译——Linux/UNC 路径对
 *         Windows PowerShell 进程不可靠，兜底到 %SystemRoot%（与 wsl-bash
 *         同策略），绝不让 spawn 因 cwd 失败；
 *   - P2：探测与冒烟测试全部改为异步（node:child_process execFile +
 *         Promise.all），env_probe 工具调用不再同步阻塞事件循环；挂载探测
 *         也改为异步，启动不再等待；
 *   - P3：环境简报感知 `wsl-` 变体（ctx.baseUrl 含 /wsl-），变体下正确描述
 *         bash 为 dsh-wsl-workspace 持久 shell、文件工具为 WSL 文件系统世界；
 *   - P4：Windows PowerShell 探测扩展候选路径（Program Files 7 / 7-preview、
 *         每用户 Programs、WindowsApps 执行别名），仍以 5.1 兜底。
 *
 * 设计约束：
 *   - 零外部依赖：用户 home 下的 preset 无法解析 harness 的 node_modules，
 *     只允许 node: 内置模块；
 *   - 一切探测失败都必须降级为 "unknown"/skip，绝不抛错伤害会话；
 *   - 首轮简报不属于 bootstrap 的 suppressedContextSources
 *     （agent-instructions / skill-catalog），因此不会被锚定过滤器剥离。
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'whale-maid-env-probe'

/** 工具注册需要 tools；pwsh-linux 工具执行与冒烟测试需要 subprocess。 */
export const inject = ['tools', 'subprocess']

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
      label: 'WSL 文件系统',
      distro: unc.distro,
      linuxPath: unc.linuxPath,
      raw,
    }
  }
  if (isAbsoluteLinuxPath(raw)) {
    return { world: 'linux', label: '原生 Linux 文件系统', linuxPath: raw, raw }
  }
  if (isWindowsDrivePath(raw)) {
    return {
      world: 'windows',
      label: 'Windows 母系统文件系统',
      path: raw,
      mntPath: windowsToMntPath(raw),
      raw,
    }
  }
  return { world: 'unknown', label: '未知世界', raw }
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
 * Windows 母系统 PowerShell 探测（win32 专用）：按「最新优先」顺序枚举常见
 * 安装位置——Program Files 的 PowerShell 7、7-preview、每用户 Programs、
 * WindowsApps 执行别名，最后兜底 Windows PowerShell 5.1。
 */
function detectWindowsPowerShell() {
  const systemRoot = process.env.SystemRoot
  const programFiles = process.env.ProgramFiles
  const localAppData = process.env.LOCALAPPDATA
  const candidates = []
  const push = (label, path) => {
    if (typeof path === 'string' && path.length > 0) {
      candidates.push({ label, path })
    }
  }
  if (typeof programFiles === 'string' && programFiles.length > 0) {
    push('Windows 母系统 PowerShell（PowerShell 7，pwsh.exe）', `${programFiles}\\PowerShell\\7\\pwsh.exe`)
    push('Windows 母系统 PowerShell（PowerShell 7 Preview，pwsh-preview.exe）', `${programFiles}\\PowerShell\\7-preview\\pwsh.exe`)
  }
  if (typeof localAppData === 'string' && localAppData.length > 0) {
    push('Windows 母系统 PowerShell（PowerShell 7 每用户安装）', `${localAppData}\\Programs\\PowerShell\\7\\pwsh.exe`)
    push('Windows 母系统 PowerShell（PowerShell 7 Preview 每用户安装）', `${localAppData}\\Programs\\PowerShell\\7-preview\\pwsh.exe`)
    // Microsoft Store 安装的执行别名（0 字节 reparse point，existsSync 可命中）。
    push('Windows 母系统 PowerShell（PowerShell 7，WindowsApps）', `${localAppData}\\Microsoft\\WindowsApps\\pwsh.exe`)
    push('Windows 母系统 PowerShell（PowerShell 7 Preview，WindowsApps）', `${localAppData}\\Microsoft\\WindowsApps\\pwsh-preview.exe`)
  }
  if (typeof systemRoot === 'string' && systemRoot.length > 0) {
    push('Windows 母系统 PowerShell（Windows PowerShell 5.1，powershell.exe）', `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`)
  }
  const seen = new Set()
  for (const cand of candidates) {
    if (seen.has(cand.path)) continue
    seen.add(cand.path)
    try {
      if (existsSync(cand.path)) {
        return { label: cand.label, argv: [cand.path, '-NoProfile', '-Command'] }
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
export async function probeStatic(timeoutMs) {
  const platform = process.platform
  const insideWsl = detectInsideWsl()
  const snapshot = {
    probedAt: Date.now(),
    platform,
    platformLabel:
      platform === 'win32' ? '原生 Windows'
      : platform === 'linux' && insideWsl ? 'WSL 内（Linux 寄宿于 Windows）'
      : platform === 'linux' ? '原生 Linux'
      : platform === 'darwin' ? 'macOS'
      : String(platform),
    insideWsl,
    wsl: { installed: false, distros: [], defaultDistro: undefined },
    pwsh: undefined, // { label, argv } 可用 PowerShell 后端（win32=Windows 母系统；非 win32=跨到 Windows 的 interop）
    wine: undefined,
  }

  if (platform === 'win32') {
    const distros = await listDistros(timeoutMs)
    snapshot.wsl = {
      installed: distros.length > 0,
      distros,
      defaultDistro: (await defaultDistro(timeoutMs)) ?? distros[0],
    }
    // Windows 母系统 PowerShell：按最新优先枚举，5.1 兜底。
    snapshot.pwsh = detectWindowsPowerShell()
  } else {
    // 原生 Linux / WSL 内：探测 pwsh 与 Windows interop。
    const pwshPath = await linuxWhich('pwsh')
    const interopPath = insideWsl ? await linuxWhich('powershell.exe') : undefined
    if (pwshPath !== undefined) {
      snapshot.pwsh = {
        label: insideWsl ? `Linux 原生 PowerShell（${pwshPath}）` : `PowerShell for Linux（${pwshPath}）`,
        argv: [pwshPath, '-NoProfile', '-Command'],
      }
    } else if (interopPath !== undefined) {
      snapshot.pwsh = {
        label: `Windows 母系统 PowerShell（WSL interop，${interopPath}）`,
        argv: [interopPath, '-NoProfile', '-Command'],
      }
    }
    const wine = await linuxWhich('wine')
    if (wine !== undefined) snapshot.wine = { path: wine }
  }
  return snapshot
}

// ── 简报生成 ───────────────────────────────────────────────────────────────

/**
 * pwsh 是 Windows 母系统进程，进程 cwd 必须是 Windows 可寻址路径。
 * - 盘符路径（C:\…）直接用；
 * - WSL UNC / Linux 路径对 pwsh 不可靠（尤其 Windows PowerShell 5.1 与
 *   未启动的发行版），一律兜底到 %SystemRoot%（与 wsl-bash 同策略），
 *   绝不让 spawn 因 cwd 失败。
 * @param {string|undefined} workdir 模型传入的 workdir 或会话 cwd。
 * @returns {string|undefined} 可直接作为 Windows 进程 cwd 的路径。
 */
function windowsCwdFor(workdir) {
  if (typeof workdir === 'string' && workdir.length > 0) {
    if (isWindowsDrivePath(workdir)) return workdir
    return process.env.SystemRoot ?? process.cwd()
  }
  return undefined
}

/**
 * 工具世界路由文案。`wslVariant` 为 true 表示本预设以 `wsl-*` 变体运行
 * （bash/文件工具由 dsh-wsl-workspace 提供，执行世界是 WSL）。
 */
function shellRoutes(snapshot, world, wslVariant = false) {
  if (snapshot.platform === 'win32') {
    const distro = world.world === 'wsl' ? world.distro : (snapshot.wsl.defaultDistro ?? '?')
    return {
      bash: wslVariant
        ? `bash  →  WSL 发行版「${distro}」内的 Linux bash（dsh-wsl-workspace 持久 shell，Linux 路径原生可用）`
        : `bash  →  WSL 发行版「${distro}」内的 Linux bash（自包含 wsl.exe 调用，Linux 路径原生可用）`,
      pwsh: snapshot.pwsh !== undefined
        ? `pwsh  →  ${snapshot.pwsh.label}（env-probe 已注册）`
        : 'pwsh  →  未检测到可用的 PowerShell，不可用',
      files: wslVariant
        ? 'read/write/edit/str_replace_editor  →  WSL 文件系统世界（\\\\wsl.localhost\\\\<distro>\\\\… 与 Linux 路径均可；Windows 文件经 /mnt/<drive> 访问）'
        : 'read/write/edit/str_replace_editor  →  Windows 宿主文件系统（Windows 路径与 \\\\wsl.localhost\\\\<distro>\\\\… 均可）；WSL 侧也可直接交给 bash',
      search: 'glob/grep  →  本平台未注册（Windows ripgrep 读不了 WSL 路径）；WSL 侧请用 bash 的 find/grep',
    }
  }
  const pwsh = snapshot.pwsh !== undefined
    ? `pwsh  →  ${snapshot.pwsh.label}（env-probe 已注册）`
    : 'pwsh  →  未检测到可用的 PowerShell，不可用'
  return {
    bash: snapshot.insideWsl
      ? `bash  →  当前 WSL 发行版的原生 Linux bash（宿主即 Linux）`
      : 'bash  →  宿主机原生 Linux bash',
    pwsh,
    files: 'read/write/edit/str_replace_editor/glob/grep  →  原生 Linux 文件系统世界',
    search: 'glob/grep  →  Linux 文件系统原生可用',
  }
}

function pathRules(snapshot, world) {
  const lines = []
  if (snapshot.platform === 'win32') {
    const distro = world.world === 'wsl' ? world.distro : (snapshot.wsl.defaultDistro ?? '<distro>')
    lines.push(`WSL 侧 → Windows 侧：/home/<user>/x  ⇢  \\\\wsl.localhost\\${distro}\\home\\<user>\\x`)
    lines.push('Windows 侧 → WSL 侧：C:\\Users\\<user>\\x  ⇢  /mnt/c/Users/<user>/x')
    lines.push('bash 里操作 Windows 文件：直接用 /mnt/<drive>/…；pwsh 里操作 WSL 文件：用 \\\\wsl.localhost\\<distro>\\…')
  } else if (snapshot.insideWsl) {
    lines.push('Windows 侧 → WSL 侧：C:\\Users\\<user>\\x  ⇢  /mnt/c/Users/<user>/x')
    lines.push('WSL 侧 → Windows 侧：/home/<user>/x  ⇢  \\\\wsl.localhost\\<distro>\\home\\<user>\\x')
    lines.push('在 WSL bash 里操作 Windows 文件：/mnt/<drive>/…；母系统命令经 pwsh 工具（interop）执行')
  } else {
    lines.push('单世界运行：无跨系统路径转换。')
    if (snapshot.wine !== undefined) lines.push(`检测到 Wine（${snapshot.wine.path}）：Windows 软件经 Wine 运行在 Linux 母系统上，前缀默认 ~/.wine`)
  }
  return lines
}

/**
 * 生成环境简报。`wslVariant` 为 true 时按 `wsl-*` 变体的执行世界描述工具路由。
 */
export function buildBrief(snapshot, cwd, wslVariant = false) {
  const world = worldOf(cwd)
  const routes = shellRoutes(snapshot, world, wslVariant)
  const rules = pathRules(snapshot, world)
  const wslLine = snapshot.platform === 'win32'
    ? `WSL 状态：${snapshot.wsl.installed ? `已安装；发行版 [${snapshot.wsl.distros.join(', ') || '无'}]；默认 ${snapshot.wsl.defaultDistro ?? '?'}` : '未安装或不可用'}`
    : snapshot.insideWsl
      ? `WSL 发行版：${process.env.WSL_DISTRO_NAME ?? '未知'}（寄宿于 Windows 母系统）`
      : 'WSL 状态：不适用（原生 Linux 宿主）'
  const smoke = snapshot.platform === 'win32'
    ? "建议首轮用 bash 冒烟验证：uname -srm; echo $0; pwd; ls /mnt/c >/dev/null 2>&1 && echo drvfs-ok"
    : "建议首轮用 bash 冒烟验证：uname -srm; echo $0; pwd"

  return [
    '【环境简报 · 大肥鱼女仆长自动探测】',
    `宿主系统：${snapshot.platformLabel}（${snapshot.platform}）`,
    `当前工作目录：${world.raw}`,
    `工作目录世界：${world.label}`,
    wslLine,
    '— 工具世界路由 —',
    `  ${routes.bash}`,
    `  ${routes.pwsh}`,
    `  ${routes.files}`,
    `  ${routes.search}`,
    '— 路径互转 —',
    ...rules.map((line) => `  ${line}`),
    `— ${smoke}`,
    '提升后随时可调用 env_probe 工具复查环境并实测两侧 shell。',
  ].join('\n')
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
    if (distro === undefined) return 'WSL 无可用发行版，跳过 bash 冒烟测试'
    return smokeCapture(
      ['wsl.exe', '-d', distro, '-e', 'bash', '-lc', 'echo env_probe_bash_ok; uname -srm; echo shell=$0; pwd'],
      timeoutMs,
    )
  }
  return smokeCapture(['bash', '-lc', 'echo env_probe_bash_ok; uname -srm; echo shell=$0; pwd'], timeoutMs)
}

/** 测试 pwsh 后端（win32=Windows 母系统 PowerShell；非 win32=探测到的跨世界后端）。 */
async function smokePwsh(snapshot, timeoutMs) {
  if (snapshot.pwsh === undefined) return '未检测到可用的 PowerShell，跳过 pwsh 冒烟测试'
  return smokeCapture(
    [...snapshot.pwsh.argv, "'env_probe_pwsh_ok'; $PSVersionTable.PSVersion.ToString(); $env:OS"],
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
  const probePromise = probeStatic(probeTimeoutMs)
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
      return await probeStatic(probeTimeoutMs)
    } catch (error) {
      const base = resolvedSnapshot ?? (await probePromise)
      return {
        ...base,
        probedAt: Date.now(),
        probeError: error && error.message ? error.message : String(error),
      }
    }
  }

  // ── 1) 首轮环境简报：每个会话注入一次 ──────────────────────────────────
  const briefed = new Set()
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    try {
      if (decision.kind === 'reject') return decision
      const session = agent?.session
      if (session === undefined || briefed.has(session.id)) return decision
      const snap = resolvedSnapshot ?? (await probePromise)
      briefed.add(session.id)
      const cwd = session.header?.cwd ?? process.cwd()
      const text = buildBrief(snap, cwd, isWslVariant)
      return {
        ...decision,
        messages: [
          ...(decision.messages ?? []),
          {
            id: `env-brief-${session.id}`,
            role: 'user',
            content: [{ type: 'text', text }],
            source: { kind: 'env-probe', form: 'brief' },
          },
        ],
      }
    } catch (error) {
      // 简报失败绝不能伤害会话：静默跳过。
      try {
        ctx.logger?.warn(`env-probe: brief injection failed: ${String(error)}`)
      } catch {}
      return decision
    }
  })

  // ── 2) env_probe 工具：复查环境 + 实测两侧 shell（全异步，不阻塞）──────
  ctx.effect(() => {
    ctx.tools.register({
      name: 'env_probe',
      description:
        '重新探测当前运行环境并实测两侧 shell：宿主系统（原生 Linux / 原生 Windows / WSL 内外）、工作目录所属世界（Windows 母系统 / WSL 文件系统 / 原生 Linux）、WSL 发行版、bash 与 pwsh 的实际调用结果、路径互转规则。',
      parameters: toJsonSchema({}),
      output: textOutput,
      async execute(_args, exec) {
        const fresh = await refresh()
        const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd()
        const world = worldOf(cwd)
        const routes = shellRoutes(fresh, world, isWslVariant)
        const smokeTimeout = Math.max(probeTimeoutMs, 15000)
        const [bashTest, pwshTest] = await Promise.all([
          smokeBash(fresh, smokeTimeout),
          smokePwsh(fresh, smokeTimeout),
        ])
        const wineLine = fresh.wine !== undefined
          ? `wine: ${fresh.wine.path}（Linux 母系统上的 Windows 兼容层）`
          : 'wine: 未检测到'
        const text = [
          buildBrief(fresh, cwd, isWslVariant),
          '— 实测结果 —',
          `bash 冒烟测试：\n${bashTest}`,
          `pwsh 冒烟测试：\n${pwshTest}`,
          wineLine,
          `工具世界路由：\n  ${routes.bash}\n  ${routes.pwsh}\n  ${routes.files}`,
        ].join('\n\n')
        return { text }
      },
    })
  })

  // ── 3) 按探测结果注册 pwsh 工具（win32=Windows 母系统 PowerShell；非 win32=跨世界后端）──
  ctx.effect(async () => {
    const snap = await probePromise
    if (snap.pwsh === undefined) return
    const pwshArgv = snap.pwsh.argv
    const label = snap.pwsh.label
    const description = snap.platform === 'win32'
      ? `Run a PowerShell command on the Windows mother system. Backend: ${label}. ` +
        'Use it to operate the Windows host directly (registry, services, files, Git, etc.). ' +
        'Commands run in a fresh process; non-zero exit codes are reported as errors.'
      : `Run a PowerShell command. Backend: ${label}. ` +
        'Use it to reach the Windows mother system when running inside WSL (powershell.exe interop) ' +
        'or to drive PowerShell on native Linux. Commands run in a fresh process; non-zero exit codes are reported as errors.'
    ctx.tools.register({
      name: 'pwsh',
      description,
      parameters: toJsonSchema({
        command: { type: 'string', required: true, description: 'The PowerShell command to execute.' },
        workdir: {
          type: 'string',
          description:
            'Optional working directory; must be a Windows path (C:\\…). ' +
            'WSL/Linux/UNC paths are not usable as the Windows PowerShell process cwd and fall back to %SystemRoot%.',
        },
      }),
      output: textOutput,
      async execute(args, exec) {
        const workdir =
          typeof args.workdir === 'string' && args.workdir.length > 0
            ? args.workdir
            : exec?.agent?.session?.header?.cwd
        const windowsCwd = windowsCwdFor(workdir)
        const signal = exec?.signal
        const handle = ctx.subprocess.spawn({
          argv: [...pwshArgv, args.command],
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
