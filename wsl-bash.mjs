/**
 * wsl-bash — 零外部依赖的「bash 直达 WSL」工具（仅 Windows 宿主启用）。
 *
 * 为什么存在：本预设的目标是单目录自包含，不依赖 dsh-wsl-workspace 插件。
 * 本插件直接在 Windows 母系统上通过 `wsl.exe` 调用 WSL 发行版内的 Linux bash：
 *
 *   wsl.exe -d <distro> [--cd <linuxCwd>] -e bash -lc <command>
 *
 * 工作目录三态翻译（与 dsh-wsl-workspace 的 shell 服务同规则）：
 *   1. \\wsl.localhost\<distro>\… （或 \\wsl$\…）→ 直接取 distro 与 Linux 路径；
 *   2. /home/… Linux 绝对路径            → 按 config.distro > Lxss 默认发行版
 *                                          > wsl.exe -l -q 第一项 解析 distro；
 *   3. C:\… Windows 盘符路径             → 翻译为 /mnt/<drive>/…，Windows 侧
 *                                          作为 spawn 的 cwd。
 *
 * 每次调用都是独立 bash 进程（非持久 PTY）；输出有界；非零退出码作为错误上报。
 * 无 OS 沙箱（Windows 无 landlock），工具描述如实说明。
 *
 * 设计约束：用户 home 下的 preset 无法解析 harness 的 @deepseek-ai/* 包，
 * 因此只允许 node: 内置模块 import。
 */

import { execFileSync } from 'node:child_process'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'whale-maid-wsl-bash'

/** 工具注册需要 tools；执行需要 subprocess。 */
export const inject = ['tools', 'subprocess']

const UNC_HOSTS = ['wsl.localhost', 'wsl$']
const LXSS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss'
const DEFAULT_TIMEOUT_MS = 120000
const DEFAULT_MAX_OUTPUT_BYTES = 64000

// ── 路径翻译 ────────────────────────────────────────────────────────────────

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

function windowsToMntPath(path) {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(path ?? '')
  if (match === null) return null
  const rest = (match[2] ?? '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '')
  return `/mnt/${(match[1] ?? '').toLowerCase()}${rest === '' ? '' : `/${rest}`}`
}

// ── WSL 探测（apply 时一次，失败降级）──────────────────────────────────────

function decodeExecOutput(buffer) {
  if (buffer === undefined || buffer === null) return ''
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  return buf.includes(0) ? buf.toString('utf16le') : buf.toString('utf8')
}

function tryCapture(fn) {
  try {
    const text = fn()
    return typeof text === 'string' ? text.trim() : ''
  } catch {
    return ''
  }
}

function listDistros(timeoutMs) {
  const text = tryCapture(() => {
    const out = execFileSync('wsl.exe', ['-l', '-q'], { encoding: 'buffer', timeout: timeoutMs, windowsHide: true })
    return decodeExecOutput(out)
  })
  return text.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0)
}

function defaultDistro(timeoutMs) {
  const text = tryCapture(() => {
    const out = execFileSync('reg.exe', ['query', LXSS_KEY, '/v', 'DefaultDistribution'], { encoding: 'buffer', timeout: timeoutMs, windowsHide: true })
    return decodeExecOutput(out)
  })
  const guid = /DefaultDistribution\s+REG_SZ\s+(\{[0-9a-fA-F-]+\})/i.exec(text)?.[1]
  if (guid === undefined) return undefined
  const name = tryCapture(() => {
    const out = execFileSync('reg.exe', ['query', `${LXSS_KEY}\\${guid}`, '/v', 'DistributionName'], { encoding: 'buffer', timeout: timeoutMs, windowsHide: true })
    return decodeExecOutput(out)
  })
  const distro = /DistributionName\s+REG_SZ\s+(.+)/i.exec(name)?.[1]?.trim()
  return distro === undefined || distro === '' ? undefined : distro
}

const LINUX_USER_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/

// ── 工具 schema（零依赖编译）───────────────────────────────────────────────

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

const commandSchema = {
  command: {
    type: 'string',
    required: true,
    description: 'The bash command to execute (bash -lc string domain, Linux world).',
  },
  workdir: {
    type: 'string',
    description:
      'Optional working directory. Accepts WSL Linux paths (/home/…), WSL UNC paths (\\\\wsl.localhost\\<distro>\\…), or Windows drive paths (C:\\…) which are translated to /mnt/<drive>.',
  },
}

/** 计算 (argv, windowsCwd)。导出便于测试与复用。 */
export function planFor(workdir, fallbackDistro, username) {
  const unc = parseWslUnc(workdir)
  if (unc !== null) {
    return {
      argv: [
        'wsl.exe', '-d', unc.distro,
        ...(username !== undefined ? ['-u', username] : []),
        '--cd', unc.linuxPath,
        '-e', 'bash', '-lc',
      ],
      windowsCwd: process.env.SystemRoot ?? process.cwd(),
    }
  }
  if (isAbsoluteLinuxPath(workdir)) {
    return {
      argv: [
        'wsl.exe', '-d', fallbackDistro,
        ...(username !== undefined ? ['-u', username] : []),
        '--cd', workdir,
        '-e', 'bash', '-lc',
      ],
      // 进程 cwd 可能是 WSL UNC（Win32 对 UNC 作进程 cwd 有限制），回退到系统目录。
      windowsCwd: process.env.SystemRoot ?? process.cwd(),
    }
  }
  const mnt = windowsToMntPath(workdir)
  if (mnt !== null) {
    return {
      argv: [
        'wsl.exe', '-d', fallbackDistro,
        ...(username !== undefined ? ['-u', username] : []),
        '--cd', mnt,
        '-e', 'bash', '-lc',
      ],
      windowsCwd: workdir,
    }
  }
  throw new Error(`wsl-bash: workdir "${workdir}" is not in any known world (WSL UNC / Linux path / Windows drive path)`)
}

// ── 插件主体 ────────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  const source = config === undefined || config === null ? {} : config
  const probeTimeoutMs =
    Number.isSafeInteger(source.probeTimeoutMs) && source.probeTimeoutMs > 0
      ? source.probeTimeoutMs
      : 10000
  const timeoutMs =
    Number.isSafeInteger(source.timeoutMs) && source.timeoutMs > 0
      ? source.timeoutMs
      : DEFAULT_TIMEOUT_MS
  const maxOutputBytes =
    Number.isSafeInteger(source.maxOutputBytes) && source.maxOutputBytes > 0
      ? source.maxOutputBytes
      : DEFAULT_MAX_OUTPUT_BYTES
  const username =
    typeof source.username === 'string' && LINUX_USER_PATTERN.test(source.username)
      ? source.username
      : undefined
  const configuredDistro =
    typeof source.distro === 'string' && source.distro.trim() !== '' ? source.distro.trim() : undefined

  // 挂载时解析一次默认发行版；解析失败 → 不注册 bash（bootstrap 会 fail-open 到全量目录）。
  const distros = listDistros(probeTimeoutMs)
  const fallbackDistro = configuredDistro ?? defaultDistro(probeTimeoutMs) ?? distros[0]
  if (fallbackDistro === undefined) {
    try {
      ctx.logger?.warn('wsl-bash: no WSL distribution available — bash tool not registered; the bootstrap will expose the full catalog')
    } catch {}
    return
  }

  /** 计算 (argv, windowsCwd)。 */
  const plan = (workdir) => planFor(workdir, fallbackDistro, username)

  ctx.effect(() => {
    ctx.tools.register({
      name: 'bash',
      description: [
        'Run commands in a bash shell inside the WSL distribution',
        '* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.',
        "* You don't have access to the internet via this tool.",
        '* You do have access to a mirror of common linux and python packages via apt and pip.',
        '* Each call runs a fresh bash -lc shell (state does NOT persist across calls).',
        '* Linux paths are native here; Windows files are reachable as /mnt/<drive> (e.g. /mnt/c/Users/...).',
        "* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.",
        '* Please avoid commands that may produce a very large amount of output.',
        "* To run long-lived work, start it in the background inside bash, e.g. 'sleep 10 &'.",
        '* NOTE: this bash runs inside WSL and is NOT confined by the Windows OS sandbox; treat output as untrusted.',
      ].join('\n'),
      parameters: toJsonSchema(commandSchema),
      timeoutMs,
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args, exec) {
        const workdir =
          typeof args.workdir === 'string' && args.workdir.length > 0
            ? args.workdir
            : exec?.agent?.session?.header?.cwd
        if (typeof workdir !== 'string' || workdir.length === 0) {
          throw new Error('wsl-bash: no workdir and no session cwd to resolve')
        }
        const { argv, windowsCwd } = plan(workdir)
        const signal = exec?.signal
        const handle = ctx.subprocess.spawn({
          argv: [...argv, args.command],
          cwd: windowsCwd,
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: maxOutputBytes },
            stderr: { maxBytes: maxOutputBytes },
          },
          env: { NO_COLOR: '1', TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat' },
          ...(signal !== undefined ? { signal } : {}),
          graceMs: 3000,
        })
        let outcome
        try {
          outcome = await handle.done
        } catch (error) {
          throw new Error(`bash spawn failed: ${String(error)}`)
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
