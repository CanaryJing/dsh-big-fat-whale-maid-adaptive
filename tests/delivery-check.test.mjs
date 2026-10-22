import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  runDeliveryCheck, inspectOfficeZip, resolveLocalPath, MAX_ZIP_ENTRIES,
} from '../delivery-check.mjs'
import { apply as applyRouter } from '../router-progressive.mjs'

async function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'delivery-check-'))
  try {
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function write(dir, name, content) {
  const path = join(dir, name)
  writeFileSync(path, content)
  return name
}

function check(dir, file, evidence, options = {}) {
  return runDeliveryCheck({ file, evidence: { items: evidence } }, { cwd: dir, ...options })
}

const textEvidence = [{ kind: 'text', label: 'review', result: 'checked' }]
const visualEvidence = [{ kind: 'image', label: 'preview', target: 'valid.png', result: 'viewed', reviewed: true }]

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Minimal uncompressed ZIP writer for parser tests (local + central + EOCD). */
function makeZip(entries) {
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.from(entry.data ?? '', 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)
    offset += local.length + name.length + data.length
  }
  const centralDirectory = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDirectory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...localParts, centralDirectory, eocd])
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  return Buffer.concat([length, body, crc])
}

function minimalPng() {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', Buffer.alloc(13)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function minimalWebp() {
  const buffer = Buffer.alloc(20)
  buffer.write('RIFF', 0, 'latin1')
  buffer.writeUInt32LE(12, 4)
  buffer.write('WEBP', 8, 'latin1')
  return buffer
}

test('valid UTF-8 deliverable plus evidence passes with an explicit basic-check scope', () => withTemp((dir) => {
  write(dir, 'deliverable.md', '# 交付\n\n中文内容。\n')
  const result = check(dir, 'deliverable.md', textEvidence)
  assert.equal(result.ok, true, JSON.stringify(result.checks))
  assert.ok(result.checks.some((item) => item.name === 'encoding-utf8' && item.pass))
  const scope = result.checks.find((item) => item.name === 'scope')
  assert.match(scope.detail, /basic file and evidence checks only/)
  assert.match(scope.detail, /no semantic, visual, or full-format guarantee/)
}))

test('invalid UTF-8 is rejected', () => withTemp((dir) => {
  write(dir, 'bad.txt', Buffer.from([0xff, 0xfe, 0xfd, 0x80]))
  const result = check(dir, 'bad.txt', textEvidence)
  assert.equal(result.ok, false)
  assert.ok(result.checks.some((item) => item.name === 'encoding-utf8' && !item.pass && /not valid UTF-8/.test(item.detail)))
}))

test('text validation limit fails instead of silently decoding a prefix', () => withTemp((dir) => {
  write(dir, 'big.txt', 'hello')
  const result = check(dir, 'big.txt', textEvidence, { maxTextBytes: 4 })
  assert.equal(result.ok, false)
  assert.ok(result.checks.some((item) => item.name === 'encoding-utf8' && !item.pass && /validation limit/.test(item.detail)))
}))

test('binary formats use signatures and basic truncation checks', () => withTemp((dir) => {
  write(dir, 'valid.png', minimalPng())
  write(dir, 'truncated.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  write(dir, 'jpeg.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]))
  write(dir, 'truncated.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))
  write(dir, 'gif.gif', Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(7), Buffer.from([0x3b])]))
  write(dir, 'webp.webp', minimalWebp())
  write(dir, 'doc.pdf', Buffer.from('%PDF-1.4\nbody\n%%EOF\n', 'latin1'))
  write(dir, 'bad.pdf', Buffer.from('%PDF-1.4\nbody\n', 'latin1'))

  assert.equal(check(dir, 'valid.png', visualEvidence).ok, true)
  assert.equal(check(dir, 'truncated.png', textEvidence).ok, false)
  assert.equal(check(dir, 'jpeg.jpg', visualEvidence).ok, true)
  assert.equal(check(dir, 'truncated.jpg', textEvidence).ok, false)
  assert.equal(check(dir, 'gif.gif', visualEvidence).ok, true)
  assert.equal(check(dir, 'webp.webp', visualEvidence).ok, true)
  assert.equal(check(dir, 'doc.pdf', visualEvidence).ok, true)
  const badPdf = check(dir, 'bad.pdf', visualEvidence)
  assert.equal(badPdf.ok, false)
  assert.ok(badPdf.checks.some((item) => item.name === 'format-pdf' && !item.pass))
}))

test('office files require a valid ZIP central directory and the required parts', () => withTemp((dir) => {
  write(dir, 'valid.png', minimalPng())
  write(dir, 'valid.docx', makeZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: '_rels/.rels', data: '<Relationships/>' },
    { name: 'word/document.xml', data: '<w:document/>' },
  ]))
  const valid = check(dir, 'valid.docx', visualEvidence)
  assert.equal(valid.ok, true, JSON.stringify(valid.checks))
  assert.ok(valid.checks.some((item) => item.name === 'format-docx' && item.pass))

  write(dir, 'missing.docx', makeZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: '_rels/.rels', data: '<Relationships/>' },
  ]))
  const missing = check(dir, 'missing.docx', visualEvidence)
  assert.equal(missing.ok, false)
  assert.ok(missing.checks.some((item) => item.name === 'format-docx' && !item.pass && /word\/document\.xml/.test(item.detail)))

  write(dir, 'forged.docx', Buffer.from('PK\x03\x04not a real central directory'))
  const forged = check(dir, 'forged.docx', visualEvidence)
  assert.equal(forged.ok, false)
  assert.ok(forged.checks.some((item) => item.name === 'format-docx' && !item.pass))

  write(dir, 'valid.xlsx', makeZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: '_rels/.rels', data: '<Relationships/>' },
    { name: 'xl/workbook.xml', data: '<workbook/>' },
  ]))
  assert.equal(check(dir, 'valid.xlsx', textEvidence).ok, true, 'xlsx keeps data/test evidence')
  write(dir, 'valid.pptx', makeZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: '_rels/.rels', data: '<Relationships/>' },
    { name: 'ppt/presentation.xml', data: '<presentation/>' },
  ]))
  assert.equal(check(dir, 'valid.pptx', visualEvidence).ok, true)
}))

test('ZIP parser rejects entry-count and directory-byte overruns without decompressing', () => withTemp((dir) => {
  const tooMany = Buffer.alloc(22)
  tooMany.writeUInt32LE(0x06054b50, 0)
  tooMany.writeUInt16LE(MAX_ZIP_ENTRIES + 1, 8)
  tooMany.writeUInt16LE(MAX_ZIP_ENTRIES + 1, 10)
  tooMany.writeUInt32LE(0, 12)
  tooMany.writeUInt32LE(0, 16)
  write(dir, 'toomany.docx', tooMany)
  const countFailure = check(dir, 'toomany.docx', textEvidence)
  assert.equal(countFailure.ok, false)
  assert.ok(countFailure.checks.some((item) => /over the .*entry limit/.test(item.detail)))

  const centralTooBig = Buffer.alloc(22)
  centralTooBig.writeUInt32LE(0x06054b50, 0)
  centralTooBig.writeUInt16LE(1, 8)
  centralTooBig.writeUInt16LE(1, 10)
  centralTooBig.writeUInt32LE(1024, 12)
  centralTooBig.writeUInt32LE(0, 16)
  write(dir, 'toobig.docx', centralTooBig)
  const sizeFailure = check(dir, 'toobig.docx', textEvidence, { maxZipCentralBytes: 16 })
  assert.equal(sizeFailure.ok, false)
  assert.ok(sizeFailure.checks.some((item) => /central directory is .*over the .*limit/.test(item.detail)))

  const limited = inspectOfficeZip(join(dir, 'toobig.docx'), 'word/document.xml', { maxCentralBytes: 16 })
  assert.equal(limited.pass, false)
  assert.match(limited.detail, /over the .*limit/)
}))

test('visual deliverables require an accepted reviewed image; xlsx stays data/test evidence', () => withTemp((dir) => {
  write(dir, 'valid.png', minimalPng())
  write(dir, 'doc.pdf', Buffer.from('%PDF-1.4\nbody\n%%EOF\n', 'latin1'))
  write(dir, 'valid.docx', makeZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: '_rels/.rels', data: '<Relationships/>' },
    { name: 'word/document.xml', data: '<w:document/>' },
  ]))
  write(dir, 'valid.pptx', makeZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: '_rels/.rels', data: '<Relationships/>' },
    { name: 'ppt/presentation.xml', data: '<presentation/>' },
  ]))
  write(dir, 'valid.xlsx', makeZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: '_rels/.rels', data: '<Relationships/>' },
    { name: 'xl/workbook.xml', data: '<workbook/>' },
  ]))
  for (const file of ['valid.png', 'doc.pdf', 'valid.docx', 'valid.pptx']) {
    const textOnly = check(dir, file, textEvidence)
    assert.equal(textOnly.ok, false, `${file} must not pass with text-only evidence`)
    assert.ok(textOnly.checks.some((item) => /visual deliverable/.test(item.detail)), file)
    assert.equal(check(dir, file, visualEvidence).ok, true, file)
  }
  assert.equal(check(dir, 'valid.xlsx', textEvidence).ok, true, 'xlsx is a data deliverable')
}))

test('visual evidence cannot be a text log with reviewed:true', () => withTemp((dir) => {
  write(dir, 'shot.png', minimalPng())
  write(dir, 'notes.txt', 'claimed screenshot')
  const result = check(dir, 'shot.png', [
    { kind: 'image', label: 'shot', target: 'notes.txt', result: 'viewed', reviewed: true },
  ])
  assert.equal(result.ok, false)
  assert.ok(result.checks.some((item) => /not a valid image/.test(item.detail)))
  assert.ok(result.checks.some((item) => /recognized image/.test(item.detail)))
}))

test('session cwd and relative targets must be native absolute paths', () => withTemp((dir) => {
  assert.equal(resolveLocalPath('test.txt', 'relative-cwd').ok, false)
  assert.equal(resolveLocalPath('test.txt', dir).ok, true)
  if (process.platform === 'win32') {
    for (const cwd of ['C:foo', '\\foo', '/foo', '\\\\server']) {
      assert.equal(resolveLocalPath('test.txt', cwd).ok, false, cwd)
    }
    assert.equal(resolveLocalPath('D:\\demo\\file.txt').ok, true)
  } else {
    for (const cwd of ['C:foo', '\\foo', 'C:\\foo']) {
      assert.equal(resolveLocalPath('test.txt', cwd).ok, false, cwd)
    }
    assert.equal(resolveLocalPath('/tmp/file.txt').ok, true)
  }
}))

test('ZIP entry data may not cover the central directory and the directory must be fully consumed', () => withTemp((dir) => {
  const valid = makeZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: '_rels/.rels', data: '<Relationships/>' },
    { name: 'word/document.xml', data: '<w:document/>' },
  ])
  const eocd = valid.length - 22
  const centralOffset = valid.readUInt32LE(eocd + 16)
  const centralSize = valid.readUInt32LE(eocd + 12)
  const firstNameLength = valid.readUInt16LE(26)

  const covers = Buffer.from(valid)
  const dataStart = 30 + firstNameLength
  const forgedSize = centralOffset - dataStart + 1
  covers.writeUInt32LE(forgedSize, 18) // local header compressed size
  covers.writeUInt32LE(forgedSize, centralOffset + 20) // central entry compressed size
  write(dir, 'covers.docx', covers)
  const coversResult = inspectOfficeZip(join(dir, 'covers.docx'), 'word/document.xml')
  assert.equal(coversResult.pass, false)
  assert.match(coversResult.detail, /central directory/)

  const padding = Buffer.alloc(4)
  const padded = Buffer.concat([valid.subarray(0, eocd), padding, valid.subarray(eocd)])
  const paddedEocd = padded.length - 22
  padded.writeUInt32LE(centralSize + padding.length, paddedEocd + 12)
  write(dir, 'padded.docx', padded)
  const paddedResult = inspectOfficeZip(join(dir, 'padded.docx'), 'word/document.xml')
  assert.equal(paddedResult.pass, false)
  assert.match(paddedResult.detail, /unparsed byte/)
}))

test('file must be a regular non-empty file and relative paths need the session cwd', () => withTemp((dir) => {
  mkdirSync(join(dir, 'adir'))
  const directory = check(dir, 'adir', textEvidence)
  assert.equal(directory.ok, false)
  assert.ok(directory.checks.some((item) => item.name === 'file-regular' && !item.pass))

  write(dir, 'empty.txt', '')
  const empty = check(dir, 'empty.txt', textEvidence)
  assert.equal(empty.ok, false)
  assert.ok(empty.checks.some((item) => item.name === 'file-nonempty' && !item.pass))

  const noCwd = runDeliveryCheck({ file: 'relative.md', evidence: { items: textEvidence } }, {})
  assert.equal(noCwd.ok, false)
  assert.ok(noCwd.checks.some((item) => item.name === 'file-path' && !item.pass && /session cwd/.test(item.detail)))
  assert.match(resolveLocalPath('relative.md').detail, /refusing to use process\.cwd\(\)/)
}))

test('unknown extensions get file/evidence checks only and say format was not verified', () => withTemp((dir) => {
  write(dir, 'artifact.whale', 'opaque but harmless')
  const result = check(dir, 'artifact.whale', textEvidence)
  assert.equal(result.ok, true, JSON.stringify(result.checks))
  const format = result.checks.find((item) => item.name === 'format-unverified')
  assert.ok(format)
  assert.match(format.detail, /no format validator/)
}))

test('evidence kinds, labels, results and local targets are validated', () => withTemp((dir) => {
  write(dir, 'deliverable.md', 'ok')
  write(dir, 'run.log', '1 passing')
  const base = check(dir, 'deliverable.md', [
    { kind: 'file', label: 'artifact', target: 'deliverable.md', result: 'built' },
    { kind: 'run', label: 'npm test', target: 'run.log', result: '1 passing' },
    { kind: 'text', label: 'summary', result: 'done' },
    { kind: 'numeric', label: 'count', result: '1' },
    { kind: 'external', label: 'docs', target: 'https://example.com/docs', result: 'referenced' },
  ])
  assert.equal(base.ok, true, JSON.stringify(base.checks))
  const evidence = base.checks.find((item) => item.name === 'delivery-evidence')
  assert.match(evidence.detail, /sha256=[0-9a-f]{64}/)
  assert.match(evidence.detail, /command not executed/)
  assert.match(evidence.detail, /no network request was made/)

  const cases = [
    [{ kind: 'run', label: 'tests', result: 'passed' }, /local target path is required/],
    [{ kind: 'file', label: '', target: 'deliverable.md', result: 'ok' }, /empty label/],
    [{ kind: 'file', label: 'x', target: 'deliverable.md' }, /empty result/],
    [{ kind: 'nope', label: 'x', result: 'ok' }, /invalid kind/],
    [{ kind: 'numeric', label: 'n', result: '' }, /empty result/],
    [{ kind: 'external', label: 'x', target: 'ftp://example.com', result: 'ok' }, /http\(s\)/],
    [{ kind: 'external', label: 'x', target: 'not a url', result: 'ok' }, /not a valid URL/],
    [{ kind: 'file', label: 'x', target: 'missing.txt', result: 'ok' }, /not readable/],
  ]
  for (const [item, pattern] of cases) {
    const result = check(dir, 'deliverable.md', [item])
    assert.equal(result.ok, false, JSON.stringify(item))
    const detail = result.checks.filter((check) => !check.pass).map((check) => check.detail).join(' ')
    assert.match(detail, pattern)
  }

  const empty = check(dir, 'deliverable.md', [])
  assert.equal(empty.ok, false)
  assert.ok(empty.checks.some((item) => item.name === 'delivery-evidence' && !item.pass))
}))

test('page/image evidence needs reviewed:true and a real image target', () => withTemp((dir) => {
  write(dir, 'page.html', '<html></html>')
  write(dir, 'screenshot.png', minimalPng())
  write(dir, 'notes.txt', 'not a screenshot')
  const unreviewed = check(dir, 'page.html', [
    { kind: 'page', label: 'page', target: 'screenshot.png', result: 'rendered' },
    { kind: 'image', label: 'shot', target: 'screenshot.png', result: 'screenshot' },
  ])
  assert.equal(unreviewed.ok, false)
  assert.ok(unreviewed.checks.some((item) => item.name === 'delivery-evidence' && /not reviewed/.test(item.detail)))

  const fakeVisuals = check(dir, 'page.html', [
    { kind: 'page', label: 'page', target: 'page.html', result: 'rendered', reviewed: true },
    { kind: 'image', label: 'shot', target: 'notes.txt', result: 'screenshot', reviewed: true },
  ])
  assert.equal(fakeVisuals.ok, false)
  assert.ok(fakeVisuals.checks.some((item) => /not a valid image/.test(item.detail)))

  const reviewed = check(dir, 'page.html', [
    { kind: 'page', label: 'page', target: 'screenshot.png', result: 'rendered', reviewed: true },
    { kind: 'image', label: 'shot', target: 'screenshot.png', result: 'screenshot', reviewed: true },
  ])
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed.checks))
  const detail = reviewed.checks.find((item) => item.name === 'delivery-evidence').detail
  assert.match(detail, /human review declaration, not a machine visual proof/)
  assert.match(detail, /sha256=[0-9a-f]{64}/)
  assert.match(detail, /image signature OK/)
}))

test('registered delivery_check tool exposes a correctly nested schema and executes', () => withTemp(async (dir) => {
  const registered = new Map()
  applyRouter({
    on: () => {},
    effect: (fn) => fn(),
    tools: { register: (tool) => { registered.set(tool.name, tool); return () => {} } },
  }, {})
  const tool = registered.get('delivery_check')
  assert.ok(tool, 'delivery_check must register')

  const parameters = tool.parameters
  assert.deepEqual(parameters.required, ['file', 'evidence'])
  assert.equal(parameters.properties.evidence.type, 'object')
  assert.deepEqual(parameters.properties.evidence.required, ['items'])
  assert.equal(parameters.properties.evidence.additionalProperties, false)
  assert.equal(parameters.properties.items, undefined, 'nested required must not leak into the properties map')
  const item = parameters.properties.evidence.properties.items.items
  assert.equal(item.type, 'object')
  assert.deepEqual(item.required, ['kind', 'label', 'result'])
  assert.equal(item.additionalProperties, false)
  assert.deepEqual(item.properties.kind.enum, ['file', 'page', 'image', 'run', 'test', 'text', 'external', 'numeric'])
  assert.equal(item.properties.reviewed.type, 'boolean')

  write(dir, 'deliverable.md', 'ok')
  const result = await tool.execute({
    file: 'deliverable.md',
    evidence: { items: textEvidence },
  }, { agent: { session: { header: { cwd: dir } } } })
  assert.equal(result.ok, true, JSON.stringify(result.checks))
}))
