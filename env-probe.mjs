/**
 * env-probe — 大肥鱼女仆长 · 环境自适应模式的环境探测与双世界 shell 路由。
 *
 * 职责：
 *   1. 挂载时探测静态环境（宿主平台、是否 WSL 内、WSL 发行版、pwsh/wine 可用性）；
 *   2. 每个会话第一次请求前注入一份「环境简报」，告诉模型 bash/pwsh/文件工具
 *      各自运行在哪个世界，以及两个世界之间的路径互转规则；
 *   3. 注册 env_probe 工具：随时复查环境，并实际冒烟测试两侧 shell；
 *   4. 按探测结果注册 pwsh 工具：win32 上为 Windows 母系统 PowerShell（优先
 *      pwsh.exe，兜底 powershell.exe）；非 Windows 宿主上为原生 Linux 的 pwsh
 *      或 WSL 内的 powershell.exe interop，让模型始终能触达 Windows 母系统。
 *
 * 设计约束：
 *   - 零外部依赖：用户 home 下的 preset 无法解析 harness 的 node_modules，
 *     只允许 node: 内置模块；
 *   - 一切探测失败都必须降级为 "unknown"/skip，绝不抛错伤害会话；
 *   - 首轮简报不属于 bootstrap 的 suppressedContextSources
 *     （agent-instructions / skill-catalog），因此不会被锚定过滤器剥离。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

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

/** 判定一个工作目录属于哪个世界。 */
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

// ── 探测辅助 ───────────────────────────────────────────────────────────────

function decodeExecOutput(buffer) {
  if (buffer === undefined || buffer === null) return ''
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  return buf.includes(0) ? buf.toString('utf16le') : buf.toString('utf8')
}

function execCapture(argv, timeoutMs, options = {}) {
  const out = execFileSync(argv[0], argv.slice(1), {
    encoding: 'buffer',
    timeout: timeoutMs,
    windowsHide: true,
    ...options,
  })
  return decodeExecOutput(out)
}

function tryCapture(fn) {
  try {
    const text = fn()
    return typeof text === 'string' ? text.trim() : ''
  } catch {
    return ''
  }
}

/** 列出已安装的 WSL 发行版（wsl.exe -l -q）。 */
function listDistros(timeoutMs) {
  const text = tryCapture(() => execCapture(['wsl.exe', '-l', '-q'], timeoutMs))
  return text.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0 && !s.includes('\0'))
}

/** 读取用户默认发行版（Lxss 注册表；失败返回 undefined）。 */
function defaultDistro(timeoutMs) {
  const text = tryCapture(() => execCapture(['reg.exe', 'query', LXSS_KEY, '/v', 'DefaultDistribution'], timeoutMs))
  const guid = /DefaultDistribution\s+REG_SZ\s+(\{[0-9a-fA-F-]+\})/i.exec(text)?.[1]
  if (guid === undefined) return undefined
  const name = tryCapture(() => execCapture(['reg.exe', 'query', `${LXSS_KEY}\\${guid}`, '/v', 'DistributionName'], timeoutMs))
  const distro = /DistributionName\s+REG_SZ\s+(.+)/i.exec(name)?.[1]?.trim()
  return distro === undefined || distro === '' ? undefined : distro
}

/** Linux 上探测某个可执行文件在 PATH 中的路径。 */
function linuxWhich(cmd) {
  const text = tryCapture(() => execCapture(['bash', '-lc', `command -v ${cmd} || true`], 8000))
  const first = text.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0)
  return first === undefined || first === '' ? undefined : first
}

/** Windows 母系统 PowerShell 探测（win32 专用）：pwsh.exe 优先，powershell.exe 兜底。 */
function detectWindowsPowerShell() {
  const candidates = []
  const programFiles = process.env.ProgramFiles
  if (typeof programFiles === 'string' && programFiles.length > 0) {
    candidates.push({
      label: 'Windows 母系统 PowerShell（PowerShell 7，pwsh.exe）',
      path: `${programFiles}\\PowerShell\\7\\pwsh.exe`,
    })
  }
  const systemRoot = process.env.SystemRoot
  if (typeof systemRoot === 'string' && systemRoot.length > 0) {
    candidates.push({
      label: 'Windows 母系统 PowerShell（Windows PowerShell 5.1，powershell.exe）',
      path: `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    })
  }
  for (const cand of candidates) {
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
  const version = tryCapture(() => readFileSync('/proc/version', 'utf8'))
  return /microsoft|wsl/i.test(version)
}

/**
 * 静态环境快照（挂载时探测一次，env_probe 工具每次调用时重新探测）。
 * 任何一项失败都降级，绝不抛错。
 */
export function probeStatic(timeoutMs) {
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
    const distros = listDistros(timeoutMs)
    snapshot.wsl = {
      installed: distros.length > 0,
      distros,
      defaultDistro: defaultDistro(timeoutMs) ?? distros[0],
    }
    // Windows 母系统 PowerShell：优先 PowerShell 7（pwsh.exe），兜底 Windows PowerShell 5.1。
    snapshot.pwsh = detectWindowsPowerShell()
  } else {
    // 原生 Linux / WSL 内：探测 pwsh 与 Windows interop。
    const pwshPath = linuxWhich('pwsh')
    const interopPath = insideWsl ? linuxWhich('powershell.exe') : undefined
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
    const wine = linuxWhich('wine')
    if (wine !== undefined) snapshot.wine = { path: wine }
  }
  return snapshot
}

// ── 简报生成 ───────────────────────────────────────────────────────────────

function shellRoutes(snapshot, world) {
  if (snapshot.platform === 'win32') {
    const distro = world.world === 'wsl' ? world.distro : (snapshot.wsl.defaultDistro ?? '?')
    return {
      bash: `bash  →  WSL 发行版「${distro}」内的 Linux bash（自包含 wsl.exe 调用，Linux 路径原生可用）`,
      pwsh: snapshot.pwsh !== undefined
        ? `pwsh  →  ${snapshot.pwsh.label}（env-probe 已注册）`
        : 'pwsh  →  未检测到可用的 PowerShell，不可用',
      files: 'read/write/edit/str_replace_editor  →  Windows 宿主文件系统（Windows 路径与 \\\\wsl.localhost\\\\<distro>\\\\… 均可）；WSL 侧也可直接交给 bash',
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

export function buildBrief(snapshot, cwd) {
  const world = worldOf(cwd)
  const routes = shellRoutes(snapshot, world)
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

// ── 冒烟测试 ───────────────────────────────────────────────────────────────

function smokeCapture(argv, timeoutMs) {
  try {
    const text = execCapture(argv, timeoutMs)
    return text.length > 0 ? text.slice(0, 4000) : '(无输出，退出码 0)'
  } catch (error) {
    const detail = error && error.stdout ? `\nstdout: ${String(error.stdout).slice(0, 500)}` : ''
    return `FAILED: ${error && error.message ? error.message : String(error)}${detail}`
  }
}

/** 测试 bash 后端（Windows 宿主 → WSL bash；Linux 宿主 → 原生 bash）。 */
function smokeBash(snapshot, timeoutMs) {
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
function smokePwsh(snapshot, timeoutMs) {
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

  // 挂载时探测一次静态环境（失败降级，不抛错）。
  const snapshot = probeStatic(probeTimeoutMs)

  /** 重新探测（env_probe 工具每次调用时刷新）。 */
  const refresh = () => {
    try {
      return probeStatic(probeTimeoutMs)
    } catch (error) {
      return {
        ...snapshot,
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
      briefed.add(session.id)
      const cwd = session.header?.cwd ?? process.cwd()
      const text = buildBrief(snapshot, cwd)
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

  // ── 2) env_probe 工具：复查环境 + 实测两侧 shell ───────────────────────
  ctx.effect(() => {
    ctx.tools.register({
      name: 'env_probe',
      description:
        '重新探测当前运行环境并实测两侧 shell：宿主系统（原生 Linux / 原生 Windows / WSL 内外）、工作目录所属世界（Windows 母系统 / WSL 文件系统 / 原生 Linux）、WSL 发行版、bash 与 pwsh 的实际调用结果、路径互转规则。',
      parameters: toJsonSchema({}),
      output: textOutput,
      async execute(_args, exec) {
        const fresh = refresh()
        const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd()
        const world = worldOf(cwd)
        const routes = shellRoutes(fresh, world)
        const smokeTimeout = Math.max(probeTimeoutMs, 15000)
        const bashTest = smokeBash(fresh, smokeTimeout)
        const pwshTest = smokePwsh(fresh, smokeTimeout)
        const wineLine = fresh.wine !== undefined
          ? `wine: ${fresh.wine.path}（Linux 母系统上的 Windows 兼容层）`
          : 'wine: 未检测到'
        const text = [
          buildBrief(fresh, cwd),
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
  if (snapshot.pwsh !== undefined) {
    const pwshArgv = snapshot.pwsh.argv
    const label = snapshot.pwsh.label
    const description = snapshot.platform === 'win32'
      ? `Run a PowerShell command on the Windows mother system. Backend: ${label}. ` +
        'Use it to operate the Windows host directly (registry, services, files, Git, etc.). ' +
        'Commands run in a fresh process; non-zero exit codes are reported as errors.'
      : `Run a PowerShell command. Backend: ${label}. ` +
        'Use it to reach the Windows mother system when running inside WSL (powershell.exe interop) ' +
        'or to drive PowerShell on native Linux. Commands run in a fresh process; non-zero exit codes are reported as errors.'
    ctx.effect(() => {
      ctx.tools.register({
        name: 'pwsh',
        description,
        parameters: toJsonSchema({
          command: { type: 'string', required: true, description: 'The PowerShell command to execute.' },
          workdir: { type: 'string', description: 'Optional working directory; defaults to the session cwd.' },
        }),
        output: textOutput,
        async execute(args, exec) {
          const workdir =
            typeof args.workdir === 'string' && args.workdir.length > 0
              ? args.workdir
              : exec?.agent?.session?.header?.cwd
          const signal = exec?.signal
          const handle = ctx.subprocess.spawn({
            argv: [...pwshArgv, args.command],
            ...(workdir !== undefined ? { cwd: workdir } : {}),
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
}
