/**
 * router-progressive — 任务模式路由 + 交付 gate（女仆长适配版 · 全量工具版）。
 *
 * 历史：本文件曾实现「四阶段渐进工具披露」（router-standard v1.20 语义移植）。
 * 2026-09 起按主人要求改为「工具一次性全部开放」，2026-10-22 起（v3.0）
 * 交给 tool-gate.mjs 做「常驻核心 + 按需解锁」：
 *   - 本插件不再过滤/限制工具目录，工具可见性由 tool-gate 决定；
 *   - 保留：任务模式路由（react/spec/consult/weak 叠加句注入 persona）、
 *     dev_router_status（路由 + 门控状态自检）、delivery_check（交付 gate）。
 *
 * 与 router-core.mjs 的关系：router-core 是纯函数库（无 apply，不作为插件装载），
 * 本插件以相对路径 import 复用 classifyTask / overlayFor / sessionMode 等。
 */

import {
  overlayFor, bandFor, sessionMode,
} from './router-core.mjs'
import { describeGate } from './tool-gate.mjs'
import { describeEffort } from './effort-policy.mjs'
import { runDeliveryCheck } from './delivery-check.mjs'

export const name = 'whale-maid-router'
export const inject = ['systemPrompt', 'tools']

const ROUTER_VERSION = 'v3.2.0-maid-effort-bands'

/**
 * 把本包的简化参数 spec 转成 JSON Schema。嵌套 required 必须放在对象 schema
 * 内（不是 properties 里），并保留 additionalProperties / items / enum。
 */
export function toJsonSchema(spec) {
  const buildObject = (meta, { forceAdditionalProperties = false } = {}) => {
    const properties = {}
    const required = Array.isArray(meta?.required)
      ? meta.required.filter((key) => typeof key === 'string')
      : []
    for (const [key, child] of Object.entries(meta?.properties || {})) {
      properties[key] = buildProp(child)
      // `required: true` is the DSL shorthand for "this parent requires the
      // child". An array is the child OBJECT's own required list and says
      // nothing about the parent (general JSON Schema semantics).
      if (child?.required === true && !required.includes(key)) required.push(key)
    }
    const schema = { type: 'object', properties }
    if (required.length > 0) schema.required = required
    if (meta?.additionalProperties !== undefined) schema.additionalProperties = meta.additionalProperties
    else if (forceAdditionalProperties) schema.additionalProperties = false
    return schema
  }
  const buildProp = (meta) => {
    if (meta === null || typeof meta !== 'object') return {}
    // Do not synthesize `type: "any"`: it is not a valid JSON Schema type and
    // the DSH schema validator rejects it. Omit `type` for an annotation-only
    // (unconstrained) property instead.
    const prop = {}
    if (typeof meta.type === 'string' && meta.type.length > 0) prop.type = meta.type
    if (Array.isArray(meta.enum)) prop.enum = [...meta.enum]
    if (meta.description) prop.description = meta.description
    if (meta.properties) Object.assign(prop, buildObject(meta))
    if (meta.items) prop.items = buildProp(meta.items)
    if (meta.additionalProperties !== undefined && meta.properties === undefined) {
      prop.additionalProperties = meta.additionalProperties
    }
    return prop
  }
  const schema = buildObject({ properties: spec }, { forceAdditionalProperties: true })
  return { type: 'object', properties: schema.properties, required: schema.required ?? [], additionalProperties: false }
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
          'toolCatalog=' + describeGate(exec?.agent),
          'effort=' + describeEffort(exec?.agent),
        ].join('\n'),
      }
    },
  })

  registerTool({
    name: 'delivery_check',
    description: 'Delivery gate: basic file + evidence checks only (regular non-empty file resolved from the session cwd; strict UTF-8 for text; signature/truncation for images/PDF; ZIP central-directory parts for docx/xlsx/pptx; local evidence files hashed; page/image reviewed is a human declaration). Outputs PASS/FAIL. All PASS before declaring completion; any FAIL must be fixed and re-run — no bypass. PASS does not prove semantics, visual quality, or full format validity.',
    parameters: {
      file: { type: 'string', required: true, description: 'Deliverable file path (absolute, or relative to exec.agent.session.header.cwd; relative without a session cwd fails)' },
      evidence: {
        type: 'object',
        // Parent requires this object; the array form below is reserved for
        // the object's own required fields (items), not the parent.
        required: true,
        description: 'Generic evidence manifest. Every item needs kind/label/result; file/page/image/run/test need a local target; page/image additionally need reviewed:true plus a real image target (human declaration, not machine proof).',
        properties: {
          items: {
            type: 'array',
            required: true,
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
              required: ['kind', 'label', 'result'],
            },
          },
        },
        additionalProperties: false,
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
      render: (_args, value) => [{ type: 'text', text: 'delivery_check: ' + (value.ok ? 'PASS (basic file and evidence checks only; no semantic/visual/full-format proof)' : 'FAIL') + '\n' + (value.checks || []).map((c) => '- ' + c.name + ': ' + (c.pass ? 'PASS' : 'FAIL') + ' — ' + c.detail).join('\n') }],
    },
    async execute(args, exec) {
      return runDeliveryCheck(args, { cwd: exec?.agent?.session?.header?.cwd })
    },
  })
}
