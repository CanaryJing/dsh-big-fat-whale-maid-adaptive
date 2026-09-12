/**
 * router-progressive — 任务模式路由 + 交付 gate（女仆长适配版 · 全量工具版）。
 *
 * 历史：本文件曾实现「四阶段渐进工具披露」（router-standard v1.20 语义移植）。
 * 2026-09 起按主人要求改为「工具一次性全部开放」：
 *   - 首轮锚定（tool-bootstrap）、注入门控（context-gate）、按需解锁
 *     （dev-tool-search）均已从 agent.cordis.yml 卸载；
 *   - 本插件不再过滤/限制工具目录——所有已注册工具从第一轮起全部可见；
 *   - 保留：任务模式路由（react/spec/weak 叠加句注入 persona）、
 *     dev_router_status（路由状态自检）、delivery_check（交付 gate）。
 *
 * 与 router-core.mjs 的关系：router-core 是纯函数库（无 apply，不作为插件装载），
 * 本插件以相对路径 import 复用 classifyTask / overlayFor / sessionMode 等。
 */

import {
  overlayFor, bandFor, sessionMode,
} from './router-core.mjs'
import { readFileSync, statSync } from 'node:fs'

export const name = 'whale-maid-router'
export const inject = ['systemPrompt', 'tools']

const ROUTER_VERSION = 'v2.0.0-maid-full'

function toJsonSchema(spec) {
  const buildProp = (meta) => {
    const prop = { type: meta?.type || 'any' }
    if (Array.isArray(meta?.enum)) prop.enum = meta.enum
    if (meta?.description) prop.description = meta.description
    if (meta?.properties) prop.properties = buildProps(meta.properties)
    if (meta?.items) prop.items = buildProp(meta.items)
    return prop
  }
  const buildProps = (props) => {
    const out = {}
    for (const [key, meta] of Object.entries(props || {})) {
      out[key] = buildProp(meta)
      if (meta?.required === true) out.required = [...(out.required || []), key]
    }
    return out
  }
  const properties = {}
  const required = []
  for (const [key, meta] of Object.entries(spec || {})) {
    properties[key] = buildProp(meta)
    if (meta?.required === true) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

const textOutput = {
  schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
  render: (_args, value) => [{ type: 'text', text: value.text }],
}

// ── 插件主体 ────────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  // 1) system-prompt/assemble：注入任务模式叠加句（不限制工具，全量开放）
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const agent = context.agent
    if (agent === undefined) return assembled
    const session = agent.session
    if (session === undefined) return assembled
    const mode = sessionMode(session)
    const modelId = assembled.variables?.model ?? ''
    const overlay = overlayFor(mode, modelId)
    const sections = (assembled.sections || []).map((s) =>
      /persona/i.test(s.name) ? { ...s, text: s.text + '\n\n' + overlay } : s,
    )
    return { ...assembled, sections }
  })

  // 2) 工具注册
  const registerTool = (tool) => {
    ctx.effect(() => ctx.tools.register({
      ...tool,
      parameters: toJsonSchema(tool.parameters),
    }))
  }

  registerTool({
    name: 'dev_router_status',
    description: 'Show the current routing state (mode, band, tool policy). No arguments.',
    parameters: {},
    output: textOutput,
    async execute(_args, exec) {
      const session = exec?.agent?.session
      if (session === undefined) return { text: 'no agent session' }
      const mode = sessionMode(session)
      return {
        text: [
          'router=whale-maid-router (' + ROUTER_VERSION + ')',
          'mode=' + String(mode) + ' (band=' + bandFor(mode) + ')',
          'fullCatalog=open (all registered tools visible from request #1; no phase gating)',
        ].join('\n'),
      }
    },
  })

  registerTool({
    name: 'delivery_check',
    description: 'Delivery gate: verify the deliverable exists / non-empty / UTF-8 + a generic evidence manifest (any artifact; pages/images must include reviewed visual evidence). Outputs PASS/FAIL. All PASS before declaring completion; any FAIL must be fixed and re-run — no bypass.',
    parameters: {
      file: { type: 'string', required: true, description: 'Deliverable file path (absolute or workspace-relative)' },
      evidence: {
        type: 'object',
        description: 'Generic evidence manifest (any artifact; pages/images need reviewed visual evidence; count is up to the task)',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', enum: ['file', 'page', 'image', 'run', 'test', 'text', 'external', 'numeric'] },
                label: { type: 'string' },
                target: { type: 'string' },
                result: { type: 'string' },
                reviewed: { type: 'boolean' },
              },
              required: ['kind', 'label'],
            },
          },
        },
        required: ['items'],
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          checks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { name: { type: 'string' }, pass: { type: 'boolean' }, detail: { type: 'string' } },
              required: ['name', 'pass', 'detail'],
            },
          },
        },
        required: ['ok', 'checks'],
      },
      render: (_args, value) => [{ type: 'text', text: 'delivery_check: ' + (value.ok ? 'PASS' : 'FAIL') + '\n' + (value.checks || []).map((c) => '- ' + c.name + ': ' + (c.pass ? 'PASS' : 'FAIL') + ' — ' + c.detail).join('\n') }],
    },
    async execute(args) {
      const file = String(args.file || '').trim()
      const checks = []
      if (!file) {
        return { ok: false, checks: [{ name: 'file-path', pass: false, detail: 'missing file parameter' }] }
      }
      try {
        const st = statSync(file)
        checks.push({ name: 'file-exists', pass: true, detail: file + ' (' + st.size + ' bytes)' })
        checks.push({ name: 'file-nonempty', pass: st.size > 0, detail: st.size > 0 ? st.size + ' bytes' : 'file is 0 bytes' })
      } catch (e) {
        return { ok: false, checks: [{ name: 'file-exists', pass: false, detail: String((e && e.message) || e) }] }
      }
      try {
        readFileSync(file, 'utf8')
        checks.push({ name: 'encoding-utf8', pass: true, detail: 'UTF-8 decode OK' })
      } catch (e) {
        checks.push({ name: 'encoding-utf8', pass: false, detail: String((e && e.message) || e) })
      }
      const items = args.evidence?.items
      if (!Array.isArray(items) || items.length === 0) {
        checks.push({ name: 'delivery-evidence', pass: false, detail: 'missing evidence items — provide at least one credible evidence item for this deliverable' })
      } else {
        const failures = []
        for (const it of items) {
          if (it.kind === 'page' || it.kind === 'image') {
            if (it.reviewed !== true) failures.push((it.label || it.kind) + ': visual evidence not reviewed (read_image review required)')
          }
          if (it.kind === 'run' && !String(it.result || '').trim()) failures.push((it.label || it.kind) + ': empty run result')
          if (it.kind === 'external' && (!String(it.target || '').trim() || !String(it.result || '').trim())) failures.push((it.label || it.kind) + ': external evidence needs target and result')
          if (it.kind === 'numeric' && !String(it.result || '').trim()) failures.push((it.label || it.kind) + ': numeric evidence needs result')
        }
        checks.push({ name: 'delivery-evidence', pass: failures.length === 0, detail: failures.length === 0 ? 'evidence accepted (' + items.length + ' item(s))' : failures.join('; ') })
      }
      return { ok: checks.every((c) => c.pass), checks }
    },
  })
}
