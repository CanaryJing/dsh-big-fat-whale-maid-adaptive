/**
 * delivery-check — 女仆长交付 gate（纯函数版）。
 *
 * v3.1.0 起把交付检查从 router-progressive.mjs 抽出，便于单测与复用。这里只做
 * 「基础文件 + 证据清单」检查：
 *   - 文件必须是会话 cwd（本平台合法绝对路径）可解析、普通、可读、非空；
 *   - 文本扩展名严格 UTF-8（TextDecoder fatal），超限 FAIL；
 *   - PNG/JPEG/GIF/WebP 做签名与基本截断检查；PDF 查头尾；
 *   - docx/xlsx/pptx 只读 ZIP central directory（不解压、不执行），校验
 *     [Content_Types].xml、_rels/.rels 和对应主文件，拒绝 data 覆盖 central
 *     directory、local 范围重叠与未消费完的声明区域；
 *   - 证据项必须有合法 kind、非空 label/result；本地 target 解析后必须普通、
 *     可读、非空，并记录 SHA256（流式，避免整文件读入内存）；
 *   - 图片/PDF/docx/pptx 页面交付至少一项 accepted page/image 且 reviewed:true；
 *     视觉 target 必须是可识别图片并通过签名检查（xlsx 只需数据/测试证据）；
 *   - 格式读取异常统一转成 FAIL check，不抛穿工具。
 *
 * 明确边界：PASS 只代表上述基础检查通过，不保证语义正确、视觉质量、完整
 * 格式合规或外部事实真实；page/image 的 reviewed 只是人工审阅声明，不能
 * 宣称机器已经看过图。
 */

import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync, readFileSync, statSync } from 'node:fs'
import { extname, isAbsolute, resolve, win32, posix } from 'node:path'

export const MAX_TEXT_BYTES = 16 * 1024 * 1024
export const MAX_ZIP_ENTRIES = 4096
export const MAX_ZIP_CENTRAL_BYTES = 8 * 1024 * 1024
export const MAX_ZIP_EOCD_SEARCH = 65557

export const EVIDENCE_KINDS = Object.freeze([
  'file', 'page', 'image', 'run', 'test', 'text', 'external', 'numeric',
])

const LOCAL_TARGET_KINDS = new Set(['file', 'page', 'image', 'run', 'test'])

const TEXT_EXTENSIONS = new Set([
  '.txt', '.text', '.md', '.markdown', '.mdx', '.log', '.json', '.json5', '.jsonc',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.scss', '.less',
  '.html', '.htm', '.xml', '.svg', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf',
  '.csv', '.tsv', '.sql', '.sh', '.bash', '.zsh', '.ps1', '.psm1', '.py', '.rb',
  '.go', '.rs', '.c', '.h', '.cc', '.cpp', '.hpp', '.java', '.kt', '.swift',
  '.php', '.lua', '.r', '.tex', '.bat', '.cmd', '.gitignore', '.env',
])

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
// Deliverables that represent pages/visual output need at least one reviewed
// visual evidence item. xlsx deliberately stays a data/test-evidence format.
const VISUAL_DELIVERABLE_EXTENSIONS = new Set([
  ...IMAGE_EXTENSIONS, '.pdf', '.docx', '.pptx',
])
const OFFICE_EXTENSIONS = new Map([
  ['.docx', 'word/document.xml'],
  ['.xlsx', 'xl/workbook.xml'],
  ['.pptx', 'ppt/presentation.xml'],
])

function text(value) {
  return typeof value === 'string' ? value : ''
}

function addCheck(checks, name, pass, detail) {
  checks.push({ name, pass: pass === true, detail: String(detail) })
}

/** 本平台合法的绝对路径：不依赖进程盘符、不接受另一平台的绝对路径。 */
export function isNativeAbsolutePath(value) {
  const raw = text(value)
  if (raw.length === 0) return false
  if (process.platform === 'win32') {
    // Drive-absolute (C:\… or C:/…) or UNC (\\server\share\… / //server/share/…).
    // C:foo, \foo and /foo are drive-relative/root-relative and must NOT be
    // accepted: their meaning depends on the process drive.
    if (/^[A-Za-z]:[\\/]/.test(raw)) return true
    return /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(raw)
  }
  if (!posix.isAbsolute(raw)) return false
  // A Windows drive path is absolute for win32 but not native here.
  return !/^[A-Za-z]:/.test(raw) && !/^[\\/]{2}/.test(raw)
}

/** 相对路径只认会话 cwd；没有会话 cwd 时绝不退回 process.cwd()。 */
export function resolveLocalPath(raw, cwd) {
  const value = text(raw).trim()
  if (value.length === 0) return { ok: false, detail: 'missing path parameter' }
  if (value.includes('\0')) return { ok: false, detail: 'path contains NUL' }
  if (isNativeAbsolutePath(value)) {
    return { ok: true, path: value }
  }
  // Explicitly reject foreign-platform and non-native absolute spellings
  // instead of letting path.resolve reinterpret them against a drive/cwd.
  if (/^[A-Za-z]:/.test(value) || /^[\\/]/.test(value)
    || isAbsolute(value) || win32.isAbsolute(value) || posix.isAbsolute(value)) {
    return {
      ok: false,
      detail: `path "${value}" is not a native absolute path for ${process.platform}; drive-relative, root-relative and foreign-platform paths are rejected`,
    }
  }
  if (typeof cwd !== 'string' || cwd.trim().length === 0) {
    return {
      ok: false,
      detail: `relative path "${value}" requires a session cwd (exec.agent.session.header.cwd); refusing to use process.cwd()`,
    }
  }
  const cwdValue = cwd.trim()
  if (!isNativeAbsolutePath(cwdValue)) {
    return {
      ok: false,
      detail: `session cwd "${cwdValue}" is not a valid absolute ${process.platform} path; refusing to resolve a relative path against it`,
    }
  }
  return { ok: true, path: resolve(cwdValue, value) }
}

function readRange(path, length, position) {
  const size = Math.max(0, Math.floor(length))
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(size)
    let total = 0
    while (total < size) {
      const read = readSync(fd, buffer, total, size - total, position + total)
      if (read <= 0) break
      total += read
    }
    return buffer.subarray(0, total)
  } finally {
    closeSync(fd)
  }
}

function sha256File(path) {
  const hash = createHash('sha256')
  const fd = openSync(path, 'r')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  try {
    let read
    while ((read = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read))
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

function checkUtf8Text(path, size, maxTextBytes) {
  if (size > maxTextBytes) {
    return [{ name: 'encoding-utf8', pass: false, detail: `text file is ${size} bytes, over the ${maxTextBytes}-byte UTF-8 validation limit; refusing a partial decode` }]
  }
  try {
    const buffer = readFileSync(path)
    new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    return [{ name: 'encoding-utf8', pass: true, detail: `strict UTF-8 decode OK (${size} bytes)` }]
  } catch (error) {
    return [{ name: 'encoding-utf8', pass: false, detail: `not valid UTF-8: ${String(error?.message || error)}` }]
  }
}

function checkPng(path, size) {
  if (size < 33) return { pass: false, detail: `truncated PNG (${size} bytes; signature + IHDR required)` }
  const head = readRange(path, 33, 0)
  if (head.length < 33 || !head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { pass: false, detail: 'missing PNG signature' }
  }
  if (head.toString('latin1', 12, 16) !== 'IHDR') return { pass: false, detail: 'PNG first chunk is not IHDR' }
  const tail = readRange(path, Math.min(64, size), Math.max(0, size - 64))
  if (!tail.includes(Buffer.from('IEND', 'latin1'))) return { pass: false, detail: 'PNG has no IEND trailer (truncated?)' }
  return { pass: true, detail: 'PNG signature + IHDR + IEND present (basic check)' }
}

function checkJpeg(path, size) {
  if (size < 4) return { pass: false, detail: `truncated JPEG (${size} bytes)` }
  const head = readRange(path, 3, 0)
  if (head.length < 3 || head[0] !== 0xff || head[1] !== 0xd8 || head[2] !== 0xff) {
    return { pass: false, detail: 'missing JPEG SOI marker' }
  }
  const tail = readRange(path, Math.min(64, size), Math.max(0, size - 64))
  if (!tail.includes(Buffer.from([0xff, 0xd9]))) {
    return { pass: false, detail: 'JPEG has no EOI marker near EOF (truncated?)' }
  }
  return { pass: true, detail: 'JPEG SOI + EOI present (basic check)' }
}

function checkGif(path, size) {
  if (size < 14) return { pass: false, detail: `truncated GIF (${size} bytes)` }
  const head = readRange(path, 6, 0)
  const signature = head.toString('latin1')
  if (signature !== 'GIF87a' && signature !== 'GIF89a') return { pass: false, detail: 'missing GIF87a/GIF89a signature' }
  const tail = readRange(path, 1, size - 1)
  if (tail.length < 1 || tail[0] !== 0x3b) return { pass: false, detail: 'GIF has no 0x3B trailer (truncated?)' }
  return { pass: true, detail: 'GIF signature + trailer present (basic check)' }
}

function checkWebp(path, size) {
  if (size < 20) return { pass: false, detail: `truncated WebP (${size} bytes)` }
  const head = readRange(path, 12, 0)
  if (head.length < 12 || head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WEBP') {
    return { pass: false, detail: 'missing RIFF/WEBP signature' }
  }
  const declared = head.readUInt32LE(4) + 8
  if (declared !== size) return { pass: false, detail: `WebP RIFF size says ${declared} bytes but file is ${size} (truncated or trailing data)` }
  return { pass: true, detail: 'WebP RIFF/WEBP + declared size match (basic check)' }
}

function checkPdf(path, size) {
  if (size < 10) return { pass: false, detail: `truncated PDF (${size} bytes)` }
  const head = readRange(path, Math.min(8, size), 0)
  if (!head.toString('latin1').startsWith('%PDF-')) return { pass: false, detail: 'missing %PDF- header' }
  const tailLength = Math.min(1024, size)
  const tail = readRange(path, tailLength, size - tailLength)
  if (!tail.toString('latin1').includes('%%EOF')) return { pass: false, detail: 'missing %%EOF trailer within the last 1024 bytes (truncated?)' }
  return { pass: true, detail: 'PDF header + %%EOF trailer present (basic check)' }
}

/**
 * 视觉证据 target 只能是可识别图片，并通过与交付文件相同的基础签名检查。
 * 文本日志/HTML/未知扩展即使 reviewed:true 也不能冒充截图。
 */
function checkImageSignature(path, extension, size) {
  switch (extension) {
    case '.png': return { name: 'evidence-image-png', ...checkPng(path, size) }
    case '.jpg':
    case '.jpeg': return { name: 'evidence-image-jpeg', ...checkJpeg(path, size) }
    case '.gif': return { name: 'evidence-image-gif', ...checkGif(path, size) }
    case '.webp': return { name: 'evidence-image-webp', ...checkWebp(path, size) }
    default:
      return {
        name: 'evidence-image-format',
        pass: false,
        detail: `visual evidence target must be a recognized image (.png/.jpg/.jpeg/.gif/.webp), got "${extension || '(no extension)'}"`,
      }
  }
}

function zipFailure(detail) {
  return { pass: false, detail }
}

/**
 * 只解析 ZIP central directory（EOCD → central entries → local headers），
 * 不调用 inflate、不执行任何条目。限制目录字节数和条目数，拒绝越界/伪造。
 */
export function inspectOfficeZip(path, mainEntry, options = {}) {
  const maxEntries = options.maxEntries ?? MAX_ZIP_ENTRIES
  const maxCentralBytes = options.maxCentralBytes ?? MAX_ZIP_CENTRAL_BYTES
  const size = options.size ?? statSync(path).size
  if (!Number.isSafeInteger(size) || size <= 0) return zipFailure('empty ZIP file')
  if (size < 22) return zipFailure('truncated ZIP (EOCD requires at least 22 bytes)')

  const fd = openSync(path, 'r')
  try {
    const searchLength = Math.min(size, MAX_ZIP_EOCD_SEARCH)
    const tail = readRangeFrom(fd, searchLength, size - searchLength)
    let eocd = -1
    for (let index = tail.length - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === 0x06054b50) {
        eocd = index
        break
      }
    }
    if (eocd < 0) return zipFailure('ZIP end-of-central-directory record not found')

    const commentLength = tail.readUInt16LE(eocd + 20)
    const eocdAbsolute = size - searchLength + eocd
    if (eocdAbsolute + 22 + commentLength !== size) {
      return zipFailure('ZIP EOCD does not end at EOF (truncated or trailing data)')
    }
    const diskNumber = tail.readUInt16LE(eocd + 4)
    const centralDisk = tail.readUInt16LE(eocd + 6)
    const entriesOnDisk = tail.readUInt16LE(eocd + 8)
    const totalEntries = tail.readUInt16LE(eocd + 10)
    const centralSize = tail.readUInt32LE(eocd + 12)
    const centralOffset = tail.readUInt32LE(eocd + 16)

    if (diskNumber !== 0 || centralDisk !== 0) return zipFailure('multi-disk ZIP is not supported')
    if (entriesOnDisk !== totalEntries) return zipFailure('ZIP entry counts disagree between disk and directory')
    if (totalEntries === 0) return zipFailure('ZIP contains no entries')
    if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      return zipFailure('ZIP64 is not supported by this basic check')
    }
    if (totalEntries > maxEntries) return zipFailure(`ZIP has ${totalEntries} entries, over the ${maxEntries}-entry limit`)
    if (centralSize > maxCentralBytes) return zipFailure(`ZIP central directory is ${centralSize} bytes, over the ${maxCentralBytes}-byte limit`)
    if (centralOffset + centralSize > eocdAbsolute) return zipFailure('ZIP central directory range exceeds EOCD (corrupt)')

    const central = readRangeFrom(fd, centralSize, centralOffset)
    if (central.length !== centralSize) return zipFailure('ZIP central directory is truncated')

    const names = new Set()
    const localRanges = []
    let offset = 0
    for (let index = 0; index < totalEntries; index += 1) {
      if (offset + 46 > central.length) return zipFailure(`ZIP central directory truncated at entry ${index + 1}`)
      if (central.readUInt32LE(offset) !== 0x02014b50) return zipFailure(`invalid ZIP central directory signature at entry ${index + 1}`)
      const flags = central.readUInt16LE(offset + 8)
      const compressedSize = central.readUInt32LE(offset + 20)
      const nameLength = central.readUInt16LE(offset + 28)
      const extraLength = central.readUInt16LE(offset + 30)
      const entryCommentLength = central.readUInt16LE(offset + 32)
      const localOffset = central.readUInt32LE(offset + 42)
      const entryEnd = offset + 46 + nameLength + extraLength + entryCommentLength
      if (entryEnd > central.length) return zipFailure(`ZIP central entry ${index + 1} overruns the directory`)
      if (nameLength === 0) return zipFailure(`ZIP central entry ${index + 1} has an empty name`)
      const name = central.toString('utf8', offset + 46, offset + 46 + nameLength)
      if (name.includes('\0')) return zipFailure(`ZIP entry ${index + 1} name contains NUL`)
      if (flags & 0x1) return zipFailure(`ZIP entry "${name}" is encrypted; basic check does not decrypt`)
      if (localOffset >= centralOffset) return zipFailure(`ZIP entry "${name}" local header starts inside the central directory`)
      if (localOffset + 30 > size) return zipFailure(`ZIP entry "${name}" local header is out of bounds`)
      if (localOffset + 30 + nameLength > size) return zipFailure(`ZIP entry "${name}" name is out of bounds`)

      const local = readRangeFrom(fd, 30, localOffset)
      if (local.length !== 30) return zipFailure(`ZIP entry "${name}" local header is truncated`)
      if (local.readUInt32LE(0) !== 0x04034b50) return zipFailure(`ZIP entry "${name}" has no local file header`)
      const localNameLength = local.readUInt16LE(26)
      const localExtraLength = local.readUInt16LE(28)
      if (localNameLength !== nameLength) return zipFailure(`ZIP entry "${name}" local/central name lengths disagree`)
      const dataStart = localOffset + 30 + localNameLength + localExtraLength
      const dataEnd = dataStart + compressedSize
      if (dataEnd > size) {
        return zipFailure(`ZIP entry "${name}" data range is out of bounds`)
      }
      // Entry data must not cover the central directory. A forged EOCD can
      // otherwise point into entry bytes while still satisfying header checks.
      if (dataStart < centralOffset && dataEnd > centralOffset) {
        return zipFailure(`ZIP entry "${name}" data range covers the central directory`)
      }
      if (dataEnd > centralOffset) {
        return zipFailure(`ZIP entry "${name}" data range extends into the central directory`)
      }
      const localName = readRangeFrom(fd, localNameLength, localOffset + 30).toString('utf8')
      if (localName !== name) return zipFailure(`ZIP entry "${name}" local/central names disagree`)
      if (names.has(name)) return zipFailure(`ZIP contains duplicate entry "${name}"`)
      // Reject overlapping local entry ranges (shared or forged local headers).
      for (const range of localRanges) {
        if (localOffset < range.end && range.start < dataEnd) {
          return zipFailure(`ZIP entry "${name}" overlaps another local entry's data range`)
        }
      }
      localRanges.push({ start: localOffset, end: dataEnd })
      names.add(name)
      offset = entryEnd
    }
    // Every declared central-directory byte must be consumed by an entry:
    // leftover padding is a forged/unparseable directory, not a valid ZIP.
    if (offset !== central.length) {
      return zipFailure(`ZIP central directory has ${central.length - offset} unparsed byte(s) beyond its ${totalEntries} entries`)
    }

    const required = ['[Content_Types].xml', '_rels/.rels', mainEntry]
    const missing = required.filter((name) => !names.has(name))
    if (missing.length > 0) return zipFailure(`ZIP is missing required part(s): ${missing.join(', ')}`)
    return {
      pass: true,
      detail: `ZIP central directory OK (${names.size} entries); required parts present: ${required.join(', ')}; contents not decompressed or executed`,
      names,
    }
  } finally {
    closeSync(fd)
  }
}

function readRangeFrom(fd, length, position) {
  if (length === 0) return Buffer.alloc(0)
  const buffer = Buffer.alloc(length)
  let total = 0
  while (total < length) {
    const read = readSync(fd, buffer, total, length - total, position + total)
    if (read <= 0) break
    total += read
  }
  return buffer.subarray(0, total)
}

function checkFileFormat(path, extension, size, options) {
  if (TEXT_EXTENSIONS.has(extension)) return checkUtf8Text(path, size, options.maxTextBytes)
  if (extension === '.png') return [{ name: 'format-png', ...checkPng(path, size) }]
  if (extension === '.jpg' || extension === '.jpeg') return [{ name: 'format-jpeg', ...checkJpeg(path, size) }]
  if (extension === '.gif') return [{ name: 'format-gif', ...checkGif(path, size) }]
  if (extension === '.webp') return [{ name: 'format-webp', ...checkWebp(path, size) }]
  if (extension === '.pdf') return [{ name: 'format-pdf', ...checkPdf(path, size) }]
  if (OFFICE_EXTENSIONS.has(extension)) {
    try {
      const result = inspectOfficeZip(path, OFFICE_EXTENSIONS.get(extension), { size, maxEntries: options.maxZipEntries, maxCentralBytes: options.maxZipCentralBytes })
      return [{ name: `format-${extension.slice(1)}`, pass: result.pass, detail: result.detail }]
    } catch (error) {
      return [{ name: `format-${extension.slice(1)}`, pass: false, detail: `ZIP validation error: ${String(error?.message || error)}` }]
    }
  }
  return [{
    name: 'format-unverified',
    pass: true,
    detail: `no format validator for "${extension || '(no extension)'}"; only basic file and evidence checks were applied`,
  }]
}

function checkEvidenceItem(item, index, cwd, failures, notes, stats) {
  const prefix = `evidence[${index}]`
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    failures.push(`${prefix}: item must be an object`)
    return false
  }
  const kind = text(item.kind).trim()
  const label = text(item.label).trim()
  const result = text(item.result).trim()
  const target = text(item.target).trim()
  if (!EVIDENCE_KINDS.includes(kind)) {
    failures.push(`${prefix}: invalid kind "${kind}" (allowed: ${EVIDENCE_KINDS.join(', ')})`)
    return false
  }
  let ok = true
  if (label.length === 0) {
    failures.push(`${prefix} (${kind}): empty label`)
    ok = false
  }
  if (result.length === 0) {
    failures.push(`${prefix} (${kind}): empty result`)
    ok = false
  }

  if (LOCAL_TARGET_KINDS.has(kind)) {
    if (target.length === 0) {
      failures.push(`${prefix} (${kind}): local target path is required`)
      return false
    }
    const resolved = resolveLocalPath(target, cwd)
    if (!resolved.ok) {
      failures.push(`${prefix} (${kind}): ${resolved.detail}`)
      return false
    }
    let stat
    try {
      stat = statSync(resolved.path)
    } catch (error) {
      failures.push(`${prefix} (${kind}): target "${resolved.path}" is not readable: ${String(error?.message || error)}`)
      return false
    }
    if (!stat.isFile()) {
      failures.push(`${prefix} (${kind}): target "${resolved.path}" is not a regular file`)
      return false
    }
    if (stat.size <= 0) {
      failures.push(`${prefix} (${kind}): target "${resolved.path}" is empty`)
      return false
    }
    let digest
    try {
      digest = sha256File(resolved.path)
    } catch (error) {
      failures.push(`${prefix} (${kind}): target "${resolved.path}" is not readable: ${String(error?.message || error)}`)
      return false
    }
    if (kind === 'page' || kind === 'image') {
      if (item.reviewed !== true) {
        failures.push(`${prefix} (${kind}): visual evidence not reviewed (reviewed:true is a human declaration; this checker does not inspect images)`)
        return false
      }
      // reviewed:true cannot point at a text log or HTML page and pretend to
      // be a screenshot: the target must be a recognized image with a valid
      // basic signature.
      const extension = extname(resolved.path).toLowerCase()
      let signature
      try {
        signature = checkImageSignature(resolved.path, extension, stat.size)
      } catch (error) {
        failures.push(`${prefix} (${kind}): visual target "${resolved.path}" could not be read: ${String(error?.message || error)}`)
        return false
      }
      if (!IMAGE_EXTENSIONS.has(extension) || !signature.pass) {
        failures.push(`${prefix} (${kind}): visual target "${resolved.path}" is not a valid image: ${signature.detail}`)
        return false
      }
      stats.visual += 1
      notes.push(`${prefix} (${kind}): ${resolved.path} sha256=${digest}; image signature OK; reviewed:true is a human review declaration, not a machine visual proof`)
      return ok
    }
    notes.push(`${prefix} (${kind}): ${resolved.path} sha256=${digest}${kind === 'run' || kind === 'test' ? '; log checked only, command not executed' : ''}`)
    return ok
  }

  if (kind === 'external') {
    if (target.length === 0) {
      failures.push(`${prefix} (external): target URL is required`)
      return false
    }
    let url
    try {
      url = new URL(target)
    } catch {
      failures.push(`${prefix} (external): target is not a valid URL`)
      return false
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      failures.push(`${prefix} (external): target must be http(s), got ${url.protocol}`)
      return false
    }
    notes.push(`${prefix} (external): URL syntax checked only; no network request was made`)
    return ok
  }

  // numeric / text: result is the evidence; there is no local target to inspect.
  notes.push(`${prefix} (${kind}): result declaration accepted (${kind === 'numeric' ? 'numeric value not independently recomputed' : 'text not independently verified'})`)
  return ok
}

/**
 * 执行交付检查。options.cwd 必须来自 exec.agent.session.header.cwd；没有
 * 会话 cwd 时相对路径直接 FAIL。
 */
export function runDeliveryCheck(args, options = {}) {
  const checks = []
  const cwd = options.cwd
  const maxTextBytes = Number.isSafeInteger(options.maxTextBytes) && options.maxTextBytes > 0
    ? options.maxTextBytes
    : MAX_TEXT_BYTES
  const rawFile = text(args?.file).trim()
  if (rawFile.length === 0) {
    addCheck(checks, 'file-path', false, 'missing file parameter')
    addCheck(checks, 'scope', true, 'basic file and evidence checks only; no semantic, visual, or full-format guarantee')
    return { ok: false, checks }
  }

  const resolved = resolveLocalPath(rawFile, cwd)
  if (!resolved.ok) {
    addCheck(checks, 'file-path', false, resolved.detail)
    addCheck(checks, 'scope', true, 'basic file and evidence checks only; no semantic, visual, or full-format guarantee')
    return { ok: false, checks }
  }
  const file = resolved.path
  addCheck(checks, 'file-path', true, file)

  let stat
  try {
    stat = statSync(file)
  } catch (error) {
    addCheck(checks, 'file-exists', false, `${file}: ${String(error?.message || error)}`)
    addCheck(checks, 'scope', true, 'basic file and evidence checks only; no semantic, visual, or full-format guarantee')
    return { ok: false, checks }
  }
  addCheck(checks, 'file-exists', true, `${file} (${stat.size} bytes)`)
  const regular = stat.isFile()
  addCheck(checks, 'file-regular', regular, regular ? 'regular file' : 'not a regular file (directory/special file rejected)')
  const nonempty = stat.size > 0
  addCheck(checks, 'file-nonempty', nonempty, nonempty ? `${stat.size} bytes` : 'file is 0 bytes')
  let readable = false
  if (regular && nonempty) {
    try {
      const fd = openSync(file, 'r')
      try {
        const probe = Buffer.alloc(1)
        readSync(fd, probe, 0, 1, 0)
      } finally {
        closeSync(fd)
      }
      readable = true
      addCheck(checks, 'file-readable', true, 'file opened and read successfully')
    } catch (error) {
      addCheck(checks, 'file-readable', false, `${file}: ${String(error?.message || error)}`)
    }
  }

  if (readable) {
    const extension = extname(file).toLowerCase()
    try {
      for (const result of checkFileFormat(file, extension, stat.size, {
        maxTextBytes,
        maxZipEntries: options.maxZipEntries,
        maxZipCentralBytes: options.maxZipCentralBytes,
      })) {
        checks.push({ name: result.name, pass: result.pass === true, detail: result.detail })
      }
    } catch (error) {
      // A read/parse failure is a FAIL verdict, never an exception escaping
      // the delivery tool (the model must see WHY delivery is blocked).
      addCheck(checks, `format-${extension ? extension.slice(1) : 'unknown'}`, false,
        `format validation error: ${String(error?.message || error)}`)
    }
  }

  const items = args?.evidence?.items
  if (!Array.isArray(items) || items.length === 0) {
    addCheck(checks, 'delivery-evidence', false, 'missing evidence items — provide at least one credible evidence item for this deliverable')
  } else {
    const failures = []
    const notes = []
    const stats = { visual: 0 }
    let accepted = 0
    items.forEach((item, index) => {
      if (checkEvidenceItem(item, index, cwd, failures, notes, stats)) accepted += 1
    })
    const deliverableExtension = extname(file).toLowerCase()
    if (VISUAL_DELIVERABLE_EXTENSIONS.has(deliverableExtension) && stats.visual === 0) {
      failures.push(`visual deliverable "${deliverableExtension}" requires at least one accepted page/image evidence item with reviewed:true and a real image target (text-only evidence is not visual proof)`)
    }
    const summary = [`accepted ${accepted} / ${items.length} item(s)`]
    if (notes.length > 0) summary.push(notes.join('; '))
    addCheck(checks, 'delivery-evidence', failures.length === 0, failures.length === 0 ? summary.join(': ') : failures.join('; '))
  }

  addCheck(checks, 'scope', true, 'basic file and evidence checks only; no semantic, visual, or full-format guarantee')
  return { ok: checks.every((check) => check.pass), checks }
}
