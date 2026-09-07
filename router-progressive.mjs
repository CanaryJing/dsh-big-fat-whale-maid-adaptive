/**
 * router-progressive — 渐进式工具披露（router-standard 移植 · 女仆长适配版）。
 *
 * 与 tool-bootstrap 协作：
 *   - tool-bootstrap 负责首轮锚定（bash + str_replace_editor，promoteOn: either）；
 *   - 晋升后本插件接管：四阶段闯关（了解 → 方案 → 开发 → 验证），预放两档，
 *     调用下一档工具自动跳级，阶段状态持久化，delivery_check 交付 gate。
 *
 * 与 router-standard 的差异：
 *   - 无 phase_begin（tool-bootstrap 的 promoteOn: either 自动晋升，零确认摩擦）；
 *   - 阶段 0 保留锚定工具 bash + str_replace_editor；
 *   - gitbash/pwsh 由 env-probe 动态注册，验证档按运行时可见面处理；
 *   - 阶段状态存 DSH_HOME/whale-maid-router/stages.json（与 router-standard 隔离）；
 *   - delivery_check 精简：文件存在/非空/UTF-8 + 证据清单（无 headless Chrome 依赖）。
 */

import {
  overlayFor, bandFor, parseMode, sessionMode, sessionEvents, extractText, advanceStage,
} from './router-core.mjs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'

export const name = 'whale-maid-router-progressive'
export const inject = ['systemPrompt', 'tools']

const ROUTER_VERSION = 'v1.0.0-maid'

const STAGES = [
  { name: 'understand', tools: ['read', 'glob', 'grep', 'web_search', 'ask_user_question', 'bash', 'str_replace_editor', 'dev_tool_search', 'skill_search', 'skill_load'] },
  { name: 'plan', tools: ['todo_write', 'exit_plan_mode'] },
  { name: 'develop', tools: ['write', 'edit'] },
  { name: 'verify', tools: ['gitbash', 'pwsh', 'read_image', 'job_list', 'job_output', 'job_kill'] },
]

const META_TOOLS = ['phase_advance', 'dev_router_status', 'dev_router_mode', 'tools_catalog', 'tools_help', 'delivery_check']

const STAGE_GUIDES = [
  'Phase: understand. Unlocked: read/glob/grep/web_search/ask_user_question + bash/str_replace_editor (anchor tools) + dev_tool_search/skill_search/skill_load (on-demand unlock). Ground first: read/ask. Break the request into dimensions and surface genuinely ambiguous ones — if one interpretation is clearly reasonable, state the assumption in one sentence and continue; if two or more interpretations materially change the result, ask ONE focused ask_user_question with concrete options. Do not under-ask nor over-ask. Complex tasks: record a plan (todo_write). Complete when: task understood (assumptions stated or key ambiguities answered).',
  'Phase: plan. Unlocked: todo_write/exit_plan_mode. Design the approach, cover edge cases, define done and acceptance criteria. Keep the task goal + current decision + live evidence in the attention window; sink settled details into memory instead of holding them all. Push independent sub-problems into subagents/workflows. Complete when: the plan is decision-complete and recorded (todo_write / exit_plan_mode). A completion signal AUTO-advances — do NOT call phase_advance after it.',
  'Phase: develop. Unlocked: write/edit. Re-read before re-edit; write/edit results carry FULL before/after text — take path/operation, inspect with grep/read. Keep the WHOLE artifact working while iterating; if a detail resists for several rounds, preserve a working version and re-attack it fresh — do not let one stubborn sub-problem stall the deliverable. Complete when: the artifact exists and passes its self-check.',
  'Phase: verify → delivery gate. Unlocked: gitbash/pwsh/read_image/jobs + delivery_check. Shell routing: Windows ops → gitbash (fallback pwsh); bash → WSL/Linux only. Verify the real artifact, not a summary — check evidence, look for defects, review visuals honestly. Gate: delivery_check must PASS — evidence manifest required; missing evidence/unreviewed visuals = FAIL.',
]

/** 窗口（v1.20 语义）：预解锁归零——只含当前档，模型看不到后续工具。 */
function windowFor(stage) { return Math.min(stage + 1, STAGES.length) }

function stageSummary(stage) {
  const unlockedEnd = windowFor(stage)
  const unlocked = STAGES.slice(0, unlockedEnd).flatMap((s) => s.tools).concat(META_TOOLS)
  const nextTier = stage + 1 < STAGES.length ? STAGES[stage + 1].tools : []
  const nextAfter = stage + 2 < STAGES.length ? STAGES[stage + 2].tools : []
  return { name: STAGES[stage].name, stage, unlocked, nextTier, nextAfter }
}

function stageText(stage) {
  const s = stageSummary(stage)
  const delivery = stage >= STAGES.length - 1
    ? '\nDelivery: restrict released — full catalog open (all registered tools).\nDelivery evidence gate: provide an evidence manifest (kind by artifact). Visual tasks: capture views + read_image review.'
    : '\nLocked: every other registered tool stays locked until its phase window opens.'
  return 'Current phase: ' + s.name + ' (' + s.stage + '/3). Callable now: ' + s.unlocked.join(', ')
    + delivery
    + '\nStage guide: ' + (STAGE_GUIDES[stage] || '')
    + '\nPhase is self-routed state: calling a pre-unlocked tool jumps the phase to that tool\'s stage; phase_advance (meta) advances one stage; or state that the phase is done.'
}

// ── 阶段持久化 ──────────────────────────────────────────────────────────────

function stateFile() {
  return join(process.env.DSH_HOME || homedir(), 'whale-maid-router', 'stages.json')
}

function loadState() {
  try {
    return JSON.parse(readFileSync(stateFile(), 'utf8'))
  } catch {
    return { version: 1, sessions: {} }
  }
}

function saveState(state) {
  try {
    mkdirSync(join(process.env.DSH_HOME || homedir(), 'whale-maid-router'), { recursive: true })
    writeFileSync(stateFile(), JSON.stringify(state, null, 2), 'utf8')
  } catch { /* 持久化失败不阻塞 */ }
}

// ── 晋升检测（与 tool-bootstrap 的 promoteOn: either 同源）──────────────────

function isPromoted(session) {
  return sessionEvents(session).some((e) => e.type === 'tool/call' || e.type === 'assistant/message')
}

// ── 工具过滤 ────────────────────────────────────────────────────────────────

/** dev_tool_search 显式解锁的工具名（从 durable tool/call 事件派生，resume 安全）。 */
function unlockedFor(session) {
  const unlocked = new Set()
  for (const event of sessionEvents(session)) {
    if (event.type !== 'tool/call') continue
    if (event.data?.name !== 'dev_tool_search') continue
    let args
    try {
      args = JSON.parse(event.data.arguments)
    } catch {
      continue
    }
    if (args === null || typeof args !== 'object' || Array.isArray(args)) continue
    const names = args.toolNames
    if (Array.isArray(names)) for (const name of names) if (typeof name === 'string' && name.length > 0) unlocked.add(name)
  }
  return unlocked
}

function restrictTools(tools, stage, session) {
  if (stage >= STAGES.length - 1) return tools
  const visible = new Set(stageSummary(stage).unlocked)
  for (const name of unlockedFor(session)) visible.add(name) // dev_tool_search 解锁的工具立即可见
  return tools.filter((tool) => visible.has(tool.name))
}

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
  // 1) system-prompt/assemble：晋升后注入 persona 叠加句 + router-stage 段 + 阶段 restrict
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const agent = context.agent
    if (agent === undefined) return assembled
    const session = agent.session
    if (session === undefined) return assembled
    if (!isPromoted(session)) return assembled // 未晋升：tool-bootstrap 负责首轮锚定
    const stage = loadState().sessions?.[session.id]?.stage ?? 0
    const mode = sessionMode(session)
    const modelId = assembled.variables?.model ?? ''
    const overlay = overlayFor(mode, modelId)
    const sections = (assembled.sections || []).map((s) =>
      /persona/i.test(s.name) ? { ...s, text: s.text + '\n\n' + overlay } : s,
    )
    sections.push({ name: 'router-stage', order: 1, text: stageText(stage) })
    const tools = restrictTools(assembled.tools, stage, session)
    return { ...assembled, sections, tools }
  })

  // 2) agent/pre-step：调用下一档工具 → 自动推进阶段
  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const decision = await next()
    if (agent === undefined || agent.session === undefined) return decision
    const session = agent.session
    if (!isPromoted(session)) return decision
    const userMsg = (messages || []).find((m) => m.role === 'user' && m.source?.kind === 'user')
    const text = userMsg ? extractText(userMsg) : ''
    const state = loadState()
    const st = state.sessions?.[session.id] ?? { stage: 0 }
    const toolCalls = sessionEvents(session)
      .filter((e) => e.type === 'tool/call' || e.type === 'tool/code-dispatch')
      .map((e) => e.data?.name || e.data?.toolName || '')
    const nextStage = advanceStage(st.stage, toolCalls, text)
    if (nextStage > st.stage) {
      st.stage = nextStage
      state.sessions[session.id] = st
      saveState(state)
      // 阶段变化由 system prompt stageText 与 dev_router_status 呈现（不插用户消息打断）
    }
    return decision
  })

  // 3) 工具注册
  const registerTool = (tool) => {
    ctx.effect(() => ctx.tools.register({
      ...tool,
      parameters: toJsonSchema(tool.parameters),
    }))
  }

  registerTool({
    name: 'phase_advance',
    description: 'Advance the progressive phase by one level (unlock next tier + phase guide). Never skips. Calling a pre-unlocked tool jumps straight to its tier — phase_advance is not needed then. In the verify/delivery phase: run delivery_check(file[, evidence]) first; only PASS allows declaring completion.',
    parameters: { reason: { type: 'string', description: 'Optional reason (recorded)' } },
    output: textOutput,
    async execute(args, exec) {
      const session = exec?.agent?.session
      if (session === undefined) return { text: 'no agent session' }
      const state = loadState()
      const st = state.sessions?.[session.id] ?? { stage: 0 }
      if (st.stage >= STAGES.length - 1) {
        return { text: 'already at the last stage (' + STAGES[st.stage].name + '); full catalog is open' }
      }
      st.stage = st.stage + 1
      state.sessions[session.id] = st
      saveState(state)
      return { text: 'advanced to phase ' + st.stage + ': ' + STAGES[st.stage].name + ' (tools unlocked: ' + STAGES.slice(0, st.stage + 1).flatMap((s) => s.tools).join(', ') + ')' }
    },
  })

  registerTool({
    name: 'dev_router_status',
    description: 'Show the current routing state (phase, band, overlay, unlocked tools, override). No arguments.',
    parameters: {},
    output: textOutput,
    async execute(_args, exec) {
      const session = exec?.agent?.session
      if (session === undefined) return { text: 'no agent session' }
      const stage = loadState().sessions?.[session.id]?.stage ?? 0
      const sum = stageSummary(stage)
      const mode = sessionMode(session)
      return {
        text: [
          'router=whale-maid-progressive (' + ROUTER_VERSION + ')',
          'phase=' + sum.name + ' (' + sum.stage + '/3)',
          'callable=[' + sum.unlocked.join(', ') + ']',
          'mode=' + String(mode) + ' (band=' + bandFor(mode) + ')',
          ...(stage >= STAGES.length - 1 ? ['fullCatalog=restrict released (all tools open)'] : []),
        ].join('\n'),
      }
    },
  })

  registerTool({
    name: 'tools_catalog',
    description: 'Progressive disclosure level 1: all tools (name + one-line summary + phase mark). query filters by keyword; domain browses by category.',
    parameters: { query: { type: 'string' }, domain: { type: 'string' } },
    output: textOutput,
    async execute(args, exec) {
      const session = exec?.agent?.session
      const stage = session === undefined ? 0 : (loadState().sessions?.[session.id]?.stage ?? 0)
      const visible = new Set(stageSummary(stage).unlocked)
      const toolsSvc = exec?.agent?.ctx?.get?.('tools')
      const scope = exec?.agent
      let all = []
      try {
        const view = toolsSvc?.view?.(scope)
        const names = new Set(view?.knownNames ?? [])
        if (typeof toolsSvc?.schemas === 'function') {
          for (const s of toolsSvc.schemas(scope)) { const nm = s.name || s.function?.name; if (nm) names.add(nm) }
        }
        all = [...names].sort()
      } catch { all = [] }
      const q = String(args.query || '').toLowerCase()
      const d = String(args.domain || '').toLowerCase()
      const dom = (n) => {
        if (/(read|write|edit|glob|grep|str_replace_editor|fs|file|path)/i.test(n)) return 'file'
        if (/(bash|pwsh|gitbash|shell|exec|command|spawn)/i.test(n)) return 'exec'
        if (/(web|search|fetch|http|network|browse)/i.test(n)) return 'network'
        if (/(subagent|agent|delegate|workflow|ralph|fork)/i.test(n)) return 'delegate'
        if (/(memory|recall|store|search)/i.test(n)) return 'memory'
        return 'other'
      }
      const stageOf = (n) => {
        const idx = STAGES.findIndex((s) => s.tools.includes(n))
        if (idx >= 0) return idx
        return META_TOOLS.includes(n) ? -1 : -2
      }
      const rows = all.filter((n) => {
        if (d && dom(n) !== d) return false
        if (q) return n.toLowerCase().includes(q) // query 单点白盒：命中未解锁也给出（带阶段标注）
        return visible.has(n) // 默认：只列当前阶段可调工具（未解锁不点名）
      }).map((n) => {
        const idx = stageOf(n)
        if (idx >= 0 && idx > stage) return '- ' + n + ' [unlocked at phase ' + idx + ']'
        if (idx === -2) return '- ' + n + ' [host]'
        return '- ' + n
      })
      if (rows.length === 0) return { text: '(no matching tools)' }
      return { text: rows.join('\n') }
    },
  })

  registerTool({
    name: 'tools_help',
    description: 'Progressive disclosure level 2: full schema of one tool (params/required/description). Query before precise calls.',
    parameters: { name: { type: 'string', required: true, description: 'Tool name (from tools_catalog)' } },
    output: textOutput,
    async execute(args, exec) {
      const name = String(args.name || '').trim()
      const toolsSvc = exec?.agent?.ctx?.get?.('tools')
      const scope = exec?.agent
      let found
      try {
        if (typeof toolsSvc?.schemas === 'function') {
          for (const s of toolsSvc.schemas(scope)) {
            if ((s?.name || s?.function?.name) === name) { found = s; break }
          }
        }
      } catch { found = undefined }
      if (!found) return { text: 'unknown tool: ' + name + ' (query tools_catalog first)' }
      const params = found.parameters || {}
      const props = params.properties || {}
      const required = params.required || []
      const lines = ['tool: ' + name, 'description: ' + (found.description || '')]
      for (const [k, v] of Object.entries(props)) {
        const meta = v || {}
        lines.push('  ' + k + ': ' + (meta.type || 'any') + (required.includes(k) ? ' (required)' : '') + ' — ' + (meta.description || ''))
      }
      return { text: lines.join('\n') }
    },
  })

  registerTool({
    name: 'delivery_check',
    description: 'Delivery gate (phase exit contract): verify the deliverable exists / non-empty / UTF-8 + a generic evidence manifest (any artifact; pages/images must include reviewed visual evidence). Outputs PASS/FAIL. All PASS before declaring completion; any FAIL must be fixed and re-run — no bypass.',
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
