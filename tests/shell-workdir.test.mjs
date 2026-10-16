import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveWorkdir,
  gitbashWorkdirPlan,
  quoteShellArg,
  gitbashCommand,
  pwshWorkdirPlan,
} from '../shell-workdir.mjs'

const invalidStrings = ['', null, false, 0, {}, [], 'bad\0path']
const relativePaths = ['.', '..', 'relative', 'C:', 'C:relative', '\\root-relative', '~', 'file:///C:/temp']
const winOptions = { platform: 'win32' }
const nativeOptions = { platform: 'linux', windowsInterop: false }
const interopOptions = { platform: 'linux', windowsInterop: true }

test('resolveWorkdir: explicit, session, process precedence without coercion or trimming', () => {
  assert.equal(resolveWorkdir('D:\\空 格\\数据', 'C:\\session'), 'D:\\空 格\\数据')
  assert.equal(resolveWorkdir(undefined, '/session/中文 space'), '/session/中文 space')
  assert.equal(resolveWorkdir(), process.cwd())
  assert.equal(resolveWorkdir(undefined, undefined), process.cwd())
  assert.equal(resolveWorkdir('  '), '  ')
  assert.equal(resolveWorkdir('C:\\explicit', null), 'C:\\explicit')
  for (const value of invalidStrings) {
    assert.throws(() => resolveWorkdir(value, 'C:\\valid'), TypeError)
    assert.throws(() => resolveWorkdir(undefined, value), TypeError)
  }
})

test('Git Bash: absolute drive paths, including roots, use literal spawn cwd', () => {
  for (const value of ['C:\\', 'D:/', 'c:/space 中文', 'D:\\$(touch x)\\`touch y`\\\'single"double', 'Z:\\not-created']) {
    assert.deepEqual(gitbashWorkdirPlan(value), { cwd: value })
  }
})

test('Git Bash: WSL UNC aliases/case and WSL root use canonical slash UNC cd', () => {
  const cases = [
    ['\\\\wsl.localhost\\Debian\\home\\空 格', '//wsl.localhost/Debian/home/空 格'],
    ['\\\\WSL$\\Debian\\home\\$(touch x)\\`touch y`', '//wsl.localhost/Debian/home/$(touch x)/`touch y`'],
    ['//WSL.LOCALHOST/Debian/\'single"double', '//wsl.localhost/Debian/\'single"double'],
    ['\\\\wsl$\\Debian', '//wsl.localhost/Debian'],
    ['//wsl.localhost/Debian/', '//wsl.localhost/Debian/'],
  ]
  for (const [value, cd] of cases) assert.deepEqual(gitbashWorkdirPlan(value), { cd })
})

test('Git Bash: SMB UNC is explicit cd, never fallback', () => {
  for (const [value, cd] of [
    ['\\\\server\\share\\空 格', '//server/share/空 格'],
    ['//server/share/$(touch x)/`touch y`/\'single"double', '//server/share/$(touch x)/`touch y`/\'single"double'],
    ['//server/share', '//server/share'],
  ]) assert.deepEqual(gitbashWorkdirPlan(value), { cd })
})

test('Git Bash: MSYS paths and drive roots do not require a distro', () => {
  for (const value of ['/c', '/c/', '/D/空 格/$(touch x)/`touch y`/\'single"double']) {
    assert.deepEqual(gitbashWorkdirPlan(value), { cd: value })
  }
})

test('Git Bash: native Linux paths require an explicit valid default distro', () => {
  for (const value of ['/', '/home/空 格/$(touch x)/`touch y`/\'single"double', '/mnt/c/project']) {
    assert.deepEqual(gitbashWorkdirPlan(value, 'Debian'), { cd: `//wsl.localhost/Debian${value}` })
    for (const distro of [undefined, ...invalidStrings, '.', '..', 'Debian/evil', 'Debian\\evil', '?']) {
      assert.throws(() => gitbashWorkdirPlan(value, distro), TypeError)
    }
  }
  assert.deepEqual(gitbashWorkdirPlan('/home/user', 'Debian Custom'), { cd: '//wsl.localhost/Debian Custom/home/user' })
})

test('Git Bash: invalid/unknown/relative/drive-relative paths fail closed', () => {
  for (const value of [undefined, ...invalidStrings, ...relativePaths]) {
    assert.throws(() => gitbashWorkdirPlan(value, 'Debian'), TypeError)
  }
})

test('both Windows backends reject incomplete UNC and device namespaces', () => {
  for (const value of ['//server', '//server/', '//', '///home/user', '\\\\wsl$\\', '\\\\?\\C:\\temp', '\\\\.\\pipe\\name', '//server/../path']) {
    assert.throws(() => gitbashWorkdirPlan(value, 'Debian'), TypeError)
    assert.throws(() => pwshWorkdirPlan(value, winOptions), TypeError)
  }
})

test('quoteShellArg: POSIX single-quote escaping is exact and literal', () => {
  assert.equal(quoteShellArg(''), "''")
  assert.equal(quoteShellArg('a b中文$()`x`"'), "'a b中文$()`x`\"'")
  assert.equal(quoteShellArg("a'b"), "'a'\"'\"'b'")
  assert.equal(quoteShellArg("''"), "''\"'\"''\"'\"''")
  for (const value of [undefined, null, 1, {}, 'a\0b']) assert.throws(() => quoteShellArg(value), TypeError)
})

test('gitbashCommand: cd -- is escaped and failure exits before the command', () => {
  const cd = '/c/空 格/$(touch x)/`touch y`/\'single"double'
  assert.equal(gitbashCommand('printf ok', cd), `cd -- ${quoteShellArg(cd)} || exit 1; printf ok`)
  assert.equal(gitbashCommand('echo "unchanged"'), 'echo "unchanged"')
  assert.equal(gitbashCommand(''), '')
  for (const command of [undefined, null, {}, 'echo\0bad']) assert.throws(() => gitbashCommand(command), TypeError)
  for (const value of invalidStrings) assert.throws(() => gitbashCommand('echo ok', value), TypeError)
})

test('Windows pwsh and Windows interop accept only absolute drives and complete UNC', () => {
  for (const options of [winOptions, interopOptions]) {
    for (const value of ['C:\\', 'D:/', 'C:\\空 格\\$(x)\\`x`\\\'"', '\\\\server\\share\\空 格', '//server/share', '\\\\wsl$\\Debian\\home']) {
      assert.deepEqual(pwshWorkdirPlan(value, options), { cwd: value })
    }
    for (const value of [undefined, ...invalidStrings, ...relativePaths, '/', '/home/user', '/c/', '/mnt/c/project']) {
      assert.throws(() => pwshWorkdirPlan(value, options), TypeError)
    }
  }
})

test('native Linux pwsh preserves native absolute cwd, including /c as a Linux directory', () => {
  for (const value of ['/', '/home/空 格/$(x)/`x`/\'"', '/c/', '/mnt/c/project', '/not-created']) {
    assert.deepEqual(pwshWorkdirPlan(value, nativeOptions), { cwd: value })
  }
  for (const value of [undefined, ...invalidStrings, ...relativePaths, 'C:\\', 'D:/data', '\\\\wsl$\\Debian', '//server/share']) {
    assert.throws(() => pwshWorkdirPlan(value, nativeOptions), TypeError)
  }
})

test('pwsh default platform is native and invalid backend flags are not coerced', () => {
  const value = process.platform === 'win32' ? 'C:\\' : '/'
  assert.deepEqual(pwshWorkdirPlan(value), { cwd: value })
  assert.throws(() => pwshWorkdirPlan(value, { platform: '' }), TypeError)
  assert.throws(() => pwshWorkdirPlan(value, { windowsInterop: 'false' }), TypeError)
})

function gitBashExecutable() {
  const candidates = [
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
    'C:\\Program Files\\Git\\bin\\bash.exe',
  ]
  const executable = candidates.find((path) => path && existsSync(path))
  assert.ok(executable, 'real Git Bash executable must be installed for Windows integration tests')
  return executable
}

function runGitBash(command, cwd) {
  const result = spawnSync(gitBashExecutable(), ['--noprofile', '--norc', '-c', command], {
    cwd, encoding: 'utf8', timeout: 10000, windowsHide: true,
  })
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.signal, null)
  return result
}

function msysPath(windowsPath) {
  return windowsPath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)
}

test('real Git Bash: quoted arguments round trip without command substitution', { skip: process.platform !== 'win32' }, () => {
  const temp = mkdtempSync(join(tmpdir(), 'shell-workdir-quote-'))
  try {
    const values = ['', '空 格', '$(touch owned-dollar)', '`touch owned-tick`', "single'quote", 'double"quote', 'line\nbreak', '\\literal\\']
    const command = `printf '%s\\0' ${values.map(quoteShellArg).join(' ')}`
    const result = runGitBash(command, temp)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, values.map((value) => `${value}\0`).join(''))
    assert.equal(existsSync(join(temp, 'owned-dollar')), false)
    assert.equal(existsSync(join(temp, 'owned-tick')), false)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('real Git Bash: safe cd reaches literal hostile directory; failed cd never runs payload', { skip: process.platform !== 'win32' }, () => {
  const temp = mkdtempSync(join(tmpdir(), 'shell-workdir-cd-'))
  try {
    // Double quotes cannot be Windows filename characters; covered by round trip above.
    const target = join(temp, "空 格-$(touch owned-dollar)-`touch owned-tick`-single'quote")
    mkdirSync(target)
    const plan = gitbashWorkdirPlan(msysPath(target))
    const success = runGitBash(gitbashCommand("printf arrived > .arrived; printf '%s' \"$PWD\"", plan.cd), temp)
    assert.equal(success.status, 0, success.stderr)
    assert.ok(existsSync(join(target, '.arrived')), 'payload must run in the requested directory')
    assert.equal(success.stdout.toLowerCase(), msysPath(target).toLowerCase())
    assert.equal(existsSync(join(temp, 'owned-dollar')), false)
    assert.equal(existsSync(join(temp, 'owned-tick')), false)

    const missing = `${msysPath(temp)}/missing-$(touch owned-failed)-single'quote`
    const failed = runGitBash(gitbashCommand('printf forbidden > after-failed-cd', missing), temp)
    assert.equal(failed.status, 1)
    assert.match(failed.stderr, /cd:/)
    assert.equal(existsSync(join(temp, 'after-failed-cd')), false)
    assert.equal(existsSync(join(temp, 'owned-failed')), false)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
