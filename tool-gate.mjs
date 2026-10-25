/**
 * tool-gate — 女仆长 v3.0「全能但常驻精简」工具门控（v3.1 增加工具组）。
 *
 * 目标（2026-10-22 主人决定）：保留全部已注册工具的能力（全能），
 * 但不再每轮把整份目录塞进请求。做法：
 *
 *   1. 常驻核心（residentTools）：按历史 109 个会话 / 7255 次调用的实际
 *      分布挑出覆盖 90%+ 的高频工具，首轮可见；
 *   2. 其余工具按需解锁：模型调用 `dev_tool_search` 按 query / toolNames /
 *      groups 解锁；实际 accepted 精确名经官方 `tool/result.meta` 持久化，
 *      下一次请求起可见（恢复会话同样有效）。恢复只信与本会话一条
 *      `dev_tool_search` callId 配对成功的 result；没有 result 的中断调用
 *      保持锁定，需要重新解锁；
 *   3. `mode: full` 一键回到旧的「全量首轮可见」，不卸载本插件即可回退；
 *   4. v3.2.0 起支持**运行期**切档：`setGateMode()` 之后下一轮组装即按新模式
 *      裁剪（监听器常驻，模式在组装时读取），供 effort-policy 按思考强度
 *      联动 progressive / full，不必重装插件。
 *
 * 为什么读会话事件而不是另存状态：会话日志本身就是持久且可恢复的，
 * 冷启动扫描一次即可重建解锁集合；压缩后仍在内存里，不需要额外存储服务。
 *
 * 注意：裁剪只作用于 `system-prompt/assemble` 返回的 `tools`，
 * 不动 sections；`ctx.tools.schemas()` 仍是全量目录，所以 dev_tool_search
 * 能搜到被锁住的工具。工具被锁时若被直接调用，DSH 报 UNKNOWN_TOOL。
 */

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'tool-gate'

/** 注册 dev_tool_search 需要 tools 服务。 */
export const inject = ['tools']

/** 门控工具自身的名字，永不裁剪。 */
export const GATE_TOOL = 'dev_tool_search'

/**
 * 固定工具组（v3.1.0）。组只做「从实际可见目录里挑名字」的展开，不授予任何
 * 权限，也不会解锁 ctx.tools.schemas(exec.agent) 里不存在的工具。
 */
export const TOOL_GROUPS = Object.freeze({
  office: {
    description: '办公文档 office_*（Word / Excel / PowerPoint 的打开、读取、编辑、渲染、保存）',
    match: (name) => name.startsWith('office_'),
  },
  'repo-files': {
    description: '仓库文件 ops_inspect_local_file / ops_grep / ops_glob / ops_replace / ops_write_file / ops_edit_file / ops_diff / ops_stat / ops_copy / ops_move / ops_remove',
    names: [
      'ops_inspect_local_file', 'ops_grep', 'ops_glob', 'ops_replace', 'ops_write_file',
      'ops_edit_file', 'ops_diff', 'ops_stat', 'ops_copy', 'ops_move', 'ops_remove',
    ],
  },
  sessions: {
    description: '会话检索 session_search / session_trace / session_event_*',
    names: ['session_search', 'session_trace'],
    match: (name) => name.startsWith('session_event_'),
  },
  team: {
    description: '多代理 spawn_teammate / team_task_* / wait_agent / interrupt_agent / send_message / list_agents',
    names: ['spawn_teammate', 'wait_agent', 'interrupt_agent', 'send_message', 'list_agents'],
    match: (name) => name.startsWith('team_task_'),
  },
  terminal: {
    description: '终端会话 terminal_*（open / send / read / signal / list / close）',
    match: (name) => name.startsWith('terminal_'),
  },
  'memory-write': {
    description: '记忆写入 mcp__openviking__* 除 read / search 外的全部（remember、edit、write、add_resource、find、tree、forget…）',
    match: (name) => name.startsWith('mcp__openviking__')
      && name !== 'mcp__openviking__read'
      && name !== 'mcp__openviking__search',
  },
})

/** 某个名字是否属于固定组。 */
export function groupMatches(groupName, toolName) {
  const group = TOOL_GROUPS[groupName]
  if (group === undefined) return false
  if (Array.isArray(group.names) && group.names.includes(toolName)) return true
  return typeof group.match === 'function' && group.match(toolName) === true
}

/**
 * 把精确名 + 组展开成实际目录里的名字。只返回目录中真实存在的工具；
 * 未知名与未知组分别报告，合法项继续处理。
 */
export function resolveToolRequest({ toolNames = [], groups = [] } = {}, schemas = []) {
  const known = new Set(schemas.map((schema) => schema?.name).filter((name) => typeof name === 'string'))
  const accepted = []
  const seen = new Set()
  const accept = (name) => {
    if (known.has(name) && !seen.has(name)) {
      seen.add(name)
      accepted.push(name)
    }
  }
  const requestedNames = [...new Set(toolNames.filter((name) => typeof name === 'string' && name.length > 0))]
  for (const name of requestedNames) accept(name)
  const missingNames = requestedNames.filter((name) => !known.has(name))

  const unknownGroups = []
  const emptyGroups = []
  const uniqueGroups = [...new Set(groups.filter((group) => typeof group === 'string' && group.length > 0))]
  for (const groupName of uniqueGroups) {
    if (TOOL_GROUPS[groupName] === undefined) {
      unknownGroups.push(groupName)
      continue
    }
    const matched = [...known].filter((name) => groupMatches(groupName, name))
    if (matched.length === 0) {
      emptyGroups.push(groupName)
      continue
    }
    for (const name of matched) accept(name)
  }
  return { accepted, missingNames, unknownGroups, emptyGroups }
}

/**
 * 默认常驻核心：按 2026-09-26 → 10-21 共 109 个会话、7255 次工具调用的
 * 实际分布选取（前 8 名覆盖 86.5%，前 25 名覆盖 97.1%）。
 * 跨平台并集：某平台上不存在的名字直接忽略，不会因此回退全量。
 */
export const DEFAULT_RESIDENT_TOOLS = [
  // shell 三通道（Windows: Git Bash / PowerShell 7 / WSL bash；Linux: bash）
  'gitbash', 'pwsh', 'bash', 'ops_bash',
  // 文件与图像
  'read', 'write', 'edit', 'str_replace_editor', 'read_image',
  // 搜索
  'grep', 'glob', 'web_search',
  // 任务与交付
  'todo_write', 'delivery_check', 'dev_router_status', 'env_probe',
  // 技能（本包 skill-search.mjs 提供）
  'skill_search', 'skill_load',
  // 记忆检索（OpenViking MCP）
  'mcp__openviking__read', 'mcp__openviking__search',
  // 交互
  'ask_user_question', 'present',
  // 目标
  'get_goal', 'update_goal',
  // 后台作业
  'job_output', 'job_list',
  // 子代理协作
  'subagent', 'send_message', 'list_agents',
]

/** 模型看得到的「已有什么 / 还能解锁什么」索引，避免它拿 bash 硬凑。 */
const UNLOCKABLE_INDEX = [
  '办公文档 — office_* （Word / Excel / PowerPoint 的打开、读取、编辑、渲染、保存）',
  '记忆写入 — mcp__openviking__* 除 read/search 外的全部（remember、edit、write、add_resource、find、tree、forget…）',
  '仓库文件工具 — ops_* （inspect_local_file、grep、glob、replace、write_file、edit_file、diff、stat、copy、move、remove）',
  '多代理 — spawn_teammate / team_task_* / wait_agent / interrupt_agent',
  '定时任务 — schedule_* （create / update / list / delete）',
  '会话检索 — session_search / session_event_* / session_trace',
  '终端会话 — terminal_* （open / send / read / signal / list / close）',
  '子代理扩展 — subagent_fork / subagent_codex / subagent_claude_code',
  '编排 — workflow / ralph',
  '图像生成 — codex_image_generate',
  '外部连接器 — chatgpt_connectors_*',
  '计划模式 — exit_plan_mode',
  '其它 — working_directory / sidebar_open / free_search_test / video_search / domain_search / research / multi_search / advanced_search / cache_search / platform_search / weather / strategy…',
]

/** 所有接受的配置键（其它键视为拼写错误）。 */
const ALLOWED_KEYS = new Set(['mode', 'residentTools', 'includeSubagents', 'maxSearchResults'])

/** 模块级运行态：describeGate 给同包其它插件读状态用。 */
const runtime = {
  mounted: false,
  mode: 'full',
  /** 会话级模式覆盖（v3.2.0）：不同会话可以各跑 progressive / full。 */
  modeBySession: new WeakMap(),
  resident: new Set(),
  state: new Map(),
  gateCalls: new Map(),
  includeSubagents: false,
  /** 运行期切档后的通知钩子（apply 时挂上），通知失败不影响切档本身。 */
  onModeChange: undefined,
}

/**
 * 运行期切换门控模式（v3.2.0，供 effort-policy 按思考强度切档）。
 *
 * 只改可见性策略，不注册也不卸载任何工具：下一次 `system-prompt/assemble`
 * 就按新模式裁剪，所以同一会话中途切档也能在下一轮生效。
 *
 * 传了 `options.session` 时只覆盖那一个会话（不同会话可以各跑各的档位）；
 * 不传就是全局默认模式。
 *
 * @param {'progressive'|'full'} mode 目标模式
 * @param {{ session?: object }} [options] 可选的会话级覆盖
 * @returns {boolean} 是否真的发生了变化（同模式重复调用是幂等的）
 * @throws {TypeError} 非法模式
 */
export function setGateMode(mode, options) {
  if (mode !== 'progressive' && mode !== 'full') {
    throw new TypeError(`${name}: mode must be "progressive" or "full"; got ${JSON.stringify(mode)}`)
  }
  const session = options?.session
  let changed
  if (session !== undefined && session !== null && typeof session === 'object') {
    changed = runtime.modeBySession.get(session) !== mode
    if (changed) runtime.modeBySession.set(session, mode)
  } else {
    changed = runtime.mode !== mode
    runtime.mode = mode
  }
  if (changed && typeof runtime.onModeChange === 'function') {
    try {
      runtime.onModeChange(mode)
    } catch {
      // 通知失败不影响切档；下一轮组装仍按新 mode 生效。
    }
  }
  return changed
}

/**
 * 当前门控模式（插件未装载时返回最近一次设定值）。
 * @param {object} [session] 传了就返回该会话的覆盖值，否则返回全局默认
 */
export function currentGateMode(session) {
  if (session !== undefined && session !== null && typeof session === 'object') {
    const override = runtime.modeBySession.get(session)
    if (override !== undefined) return override
  }
  return runtime.mode
}

function booleanOption(value, field, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new TypeError(`${name}: ${field} must be a boolean`)
  return value
}

function stringList(value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${name}: ${field} must be a non-empty array of non-empty strings`)
  }
  if (value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name}: ${field} must contain only non-empty strings`)
  }
  return [...new Set(value)]
}

function positiveInt(value, field, fallback) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name}: ${field} must be a positive safe integer`)
  }
  return value
}

/** 读一条 tool/call 事件里的精确名单（arguments 可能是 JSON 字符串或对象）。 */
function gateCallFromEvent(event) {
  if (event?.type !== 'tool/call') return undefined
  const data = event.data
  if (data === undefined || data === null) return undefined
  if (data.name !== GATE_TOOL) return undefined
  const raw = data.arguments
  let args = raw
  if (typeof raw === 'string') {
    try {
      args = JSON.parse(raw)
    } catch {
      return undefined
    }
  }
  if (args === null || typeof args !== 'object') return undefined
  const toolNames = Array.isArray(args.toolNames)
    ? args.toolNames.filter((item) => typeof item === 'string' && item.length > 0)
    : []
  const groups = Array.isArray(args.groups)
    ? args.groups.filter((item) => typeof item === 'string' && item.length > 0)
    : []
  return {
    callId: typeof data.callId === 'string' ? data.callId : undefined,
    toolNames,
    groups,
  }
}

/**
 * 从 tool/result 的 tool-private meta 读取「实际 accepted 名字」。
 * 这是 DSH 官方 ToolResult.meta 通道：只随成功结果持久化，失败结果不恢复。
 * gate 标记是必要条件——调用方还必须证明该 result 与一条 dev_tool_search
 * tool/call 成功配对，绝不能只看 callId 或只看 meta。
 *
 * 返回值区分三种情况：`undefined` = 没有本工具的有效 meta（才允许旧文案回退）；
 * `[]` = 本工具明确记录「本次没有解锁任何工具」，是权威结果，绝不能回退；
 * 非空数组 = 本工具明确记录的精确名。
 */
function acceptedFromResultEvent(event) {
  if (event?.type !== 'tool/result' || resultIsError(event)) return undefined
  const meta = event.data?.meta
  if (meta === null || typeof meta !== 'object') return undefined
  if (meta.gate !== GATE_TOOL) return undefined
  if (!Array.isArray(meta.accepted)) return undefined
  return meta.accepted.filter((name) => typeof name === 'string' && name.length > 0)
}

function resultIsError(event) {
  const data = event?.data
  return data?.error !== undefined || data?.message?.isError === true
}

/**
 * 兼容没有 meta 的 v3.0 成功结果：从本工具固定的成功文案里读 accepted 精确名。
 * 只读取我们自己的结果文本，不执行、不解析其它工具；调用方必须先证明该
 * result 与一条 dev_tool_search callId 配对成功。
 */
function acceptedFromGateText(event) {
  if (event?.type !== 'tool/result' || resultIsError(event)) return []
  const content = event.data?.message?.content
  if (!Array.isArray(content)) return []
  const text = content.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('\n')
  const match = /已解锁（下一次请求起可见）：([^\n]+)/.exec(text)
  if (match === null) return []
  return match[1].split(/[,，]\s*/).map((name) => name.trim()).filter((name) => name.length > 0)
}

/**
 * 冷启动扫一遍持久日志，重建该会话的解锁集合（恢复会话同样有效）。
 *
 * 只有与一条 dev_tool_search tool/call 成功配对的 tool/result 才可信：
 *   - 新格式：meta.gate === GATE_TOOL 且 meta.accepted 是权威精确名
 *     （空数组表示本次没有解锁任何工具，同样权威，不回退旧文案）；
 *   - v3.0 兼容：完全没有 meta 时只认本工具固定的成功文案；
 *   - 组只持久化展开后的精确名，恢复时绝不重新展开组；
 *   - 失败 result 不恢复；只有 tool/call、没有 result 的中断调用也不恢复
 *     （旧日志无法区分成功与中断，保守保持锁定，需要重新调用解锁）。
 * 其它工具的 result 文本/meta 即使伪造 gate 名字也不会被采信。
 */
function sessionEvents(session) {
  if (Array.isArray(session?.events)) return session.events
  if (typeof session?.snapshotEvents === 'function') {
    try {
      return session.snapshotEvents()
    } catch {
      return []
    }
  }
  return []
}

/** 本会话里所有 dev_tool_search tool/call，按 callId 配对。 */
function gateCallsForSession(session) {
  const calls = new Map()
  const live = runtime.gateCalls.get(session?.id)
  if (live !== undefined) {
    for (const [callId, call] of live) calls.set(callId, call)
  }
  for (const event of sessionEvents(session)) {
    const call = gateCallFromEvent(event)
    if (call?.callId !== undefined) calls.set(call.callId, call)
  }
  return calls
}

/** 从一条与 gate 调用配对的成功 result 里取真实 accepted 精确名。 */
function acceptedFromPairedResult(event) {
  if (resultIsError(event)) return []
  const fromMeta = acceptedFromResultEvent(event)
  // 空数组也是本工具的权威结果（例如只做搜索、没有解锁任何工具）：
  // 只做搜索时第三方工具描述里可能恰好含“已解锁…”文案，绝不能回退。
  if (fromMeta !== undefined) return fromMeta
  const meta = event?.data?.meta
  // 旧文案回退只服务于完全没有 meta 的 v3.0 结果。其它工具的 meta（包括
  // 伪造 gate 字段/形状不完整）不能被当作本工具成功，也不触发文案回退。
  if (meta !== null && typeof meta === 'object') return []
  return acceptedFromGateText(event)
}

function scanSession(session) {
  const unlocked = new Set()
  const calls = gateCallsForSession(session)
  if (calls.size === 0) return { unlocked }
  for (const event of sessionEvents(session)) {
    if (event?.type !== 'tool/result') continue
    const callId = event.data?.message?.toolCallId
    if (typeof callId !== 'string' || !calls.has(callId)) continue
    for (const name of acceptedFromPairedResult(event)) unlocked.add(name)
  }
  return { unlocked }
}

/** 取（或懒建）某会话的门控状态。 */
function entryFor(session) {
  let entry = runtime.state.get(session.id)
  if (entry === undefined) {
    entry = scanSession(session)
    runtime.state.set(session.id, entry)
  }
  return entry
}

/**
 * 给同包插件（router-progressive 的 dev_router_status）读当前门控状态，
 * 让状态自检文案与真实工具策略一致。未挂载时如实说未挂载。
 */
export function describeGate(agent) {
  if (!runtime.mounted) return 'tool-gate not mounted (full catalog)'
  const session = agent?.session
  const mode = currentGateMode(session)
  if (mode === 'full') return 'full (all registered tools visible)'
  if (session === undefined) return `progressive (no session; resident=${runtime.resident.size})`
  const entry = runtime.state.get(session.id) ?? scanSession(session)
  return `progressive (resident=${runtime.resident.size}, unlocked=${entry.unlocked.size}, gate=${GATE_TOOL})`
}

function gateOutput() {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        accepted: { type: 'array', items: { type: 'string' } },
      },
      required: ['text', 'accepted'],
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
    // 只把真实 accepted 精确名写进 tool/result.meta；组名永远不持久化。
    presentationMeta: (_args, value) => ({ gate: GATE_TOOL, accepted: [...value.accepted] }),
  }
}

function toJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, meta] of Object.entries(spec || {})) {
    const prop = { type: meta.type }
    if (meta.description) prop.description = meta.description
    if (meta.items) prop.items = meta.items
    properties[key] = prop
    if (meta.required) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

/** 搜索打分：命中 token 数 + 前缀/精确名加成。 */
function scoreTool(schema, tokens) {
  const name = String(schema.name ?? '').toLowerCase()
  const description = String(schema.description ?? '').toLowerCase()
  let score = 0
  for (const token of tokens) {
    if (name === token) score += 10
    if (name.includes(token)) score += 4
    if (description.includes(token)) score += 1
  }
  return score
}

export function apply(ctx, config) {
  const source = config === undefined ? {} : config
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new TypeError(`${name}: config must be an object`)
  }
  const unknown = Object.keys(source).filter((key) => !ALLOWED_KEYS.has(key))
  if (unknown.length > 0) {
    throw new TypeError(`${name}: unknown config key(s) ${unknown.join(', ')} — allowed: ${[...ALLOWED_KEYS].sort().join(', ')}`)
  }

  const mode = source.mode === undefined ? 'progressive' : source.mode
  if (mode !== 'progressive' && mode !== 'full') {
    throw new TypeError(`${name}: mode must be "progressive" or "full"; got ${JSON.stringify(mode)}`)
  }
  const resident = new Set(source.residentTools === undefined
    ? DEFAULT_RESIDENT_TOOLS
    : stringList(source.residentTools, 'residentTools'))
  resident.add(GATE_TOOL)
  const includeSubagents = booleanOption(source.includeSubagents, 'includeSubagents', false)
  const maxSearchResults = positiveInt(source.maxSearchResults, 'maxSearchResults', 25)

  runtime.mounted = true
  runtime.mode = mode
  runtime.resident = resident
  runtime.includeSubagents = includeSubagents
  runtime.onModeChange = () => {
    try {
      ctx.emit?.('tools/change')
    } catch {
      // 老版本 ctx 没有 emit：可见性只靠每轮组装，不影响正确性。
    }
  }

  let warned = false
  const warnOnce = (message) => {
    if (warned) return
    warned = true
    try {
      ctx.logger?.warn(message)
    } catch {
      // 日志不可用时忽略：这条只是避免刷屏。
    }
  }

  // ── 增量维护解锁集合：只有与 gate callId 配对的成功 result 才是事实 ──
  ctx.on('session/event', (session, event) => {
    if (session === undefined || session.id === undefined || event === undefined) return
    if (event.type === 'tool/call') {
      const call = gateCallFromEvent(event)
      if (call?.callId !== undefined) {
        let calls = runtime.gateCalls.get(session.id)
        if (calls === undefined) {
          calls = new Map()
          runtime.gateCalls.set(session.id, calls)
        }
        calls.set(call.callId, call)
      }
      return
    }
    if (event.type !== 'tool/result') return
    const callId = event.data?.message?.toolCallId
    if (typeof callId !== 'string') return
    // Pair with THIS session's dev_tool_search call. A result from any other
    // tool is ignored even when it carries meta.gate or the success wording.
    if (!gateCallsForSession(session).has(callId)) return
    const accepted = acceptedFromPairedResult(event)
    if (accepted.length === 0) return
    const entry = entryFor(session)
    for (const toolName of accepted) entry.unlocked.add(toolName)
  })

  // ── 门控本体：只裁 tools，不动 sections ────────────────────────────────
  // v3.2.0：监听器始终注册，模式在每次组装时按会话读取（currentGateMode），
  // 因此 effort-policy 可以在运行期（下一轮）切档，不必重装插件。
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const gatedSession = context?.agent?.session
    if (currentGateMode(gatedSession) !== 'progressive') return assembled
    try {
      const session = gatedSession
      if (session === undefined) return assembled
      if (!includeSubagents && (session.header?.delegationDepth ?? 0) > 0) return assembled
      const tools = Array.isArray(assembled?.tools) ? assembled.tools : undefined
      if (tools === undefined) return assembled
      // 安全网：门控工具没注册成功时保持全量，绝不把会话锁死。
      if (!tools.some((tool) => tool?.name === GATE_TOOL)) {
        warnOnce(`${name}: ${GATE_TOOL} is not in the assembled catalog — exposing every tool`)
        return assembled
      }
      const entry = entryFor(session)
      const keep = new Set(resident)
      for (const toolName of entry.unlocked) keep.add(toolName)
      return { ...assembled, tools: tools.filter((tool) => keep.has(tool?.name)) }
    } catch (error) {
      // 过滤器自身的 bug 不能砖化会话：降级为全量。
      warnOnce(`${name}: gate filter failed, exposing every tool: ${String((error && error.message) || error)}`)
      return assembled
    }
  })

  // ── 模型侧入口：搜索 + 按精确名/组解锁 ──────────────────────────────
  ctx.tools.register({
    name: GATE_TOOL,
    description: [
      '发现并解锁当前**不可见**的工具（只改变可见性，不授予权限）。',
      '',
      '本会话只常驻一组高频核心工具（shell、文件读写、搜索、任务、技能、记忆读取、子代理协作）。其余工具仍然可用，但需要先通过本工具解锁：',
      '  • 传 `query` 搜索全量目录（任一关键词命中即参与打分，不是全部关键词 AND）；',
      '  • 传 `toolNames`（精确名数组）解锁，下一次请求起可见，直到会话结束或压缩后仍保留；',
      '  • 传 `groups`（固定组数组）批量解锁：office / repo-files / sessions / team / terminal / memory-write。组只从当前实际目录展开；',
      '  • 三者可同时传：一次搜索 + 解锁。',
      '',
      '需要下列能力时，务必先搜索/解锁，不要用 bash 硬凑或宣称做不到：',
      ...UNLOCKABLE_INDEX.map((line) => `  - ${line}`),
      '',
      '注意：搜索为空只代表没有工具命中这些关键词，不代表工具不存在。确知名字时直接解锁：dev_tool_search({"toolNames":["office_open"]})。',
      '无参调用返回当前门控概览（常驻数量、已解锁数量、固定组及用途）。',
    ].join('\n'),
    parameters: toJsonSchema({
      query: { type: 'string', required: false, description: '搜索关键词（1-2 个词最准，例如 "office"、"terminal"）' },
      toolNames: { type: 'array', required: false, items: { type: 'string' }, description: '按精确工具名解锁' },
      groups: { type: 'array', required: false, items: { type: 'string' }, description: '按固定组解锁：office / repo-files / sessions / team / terminal / memory-write' },
    }),
    output: gateOutput(),
    async execute(args, exec) {
      const query = typeof args?.query === 'string' ? args.query.trim() : ''
      const requestedGroups = Array.isArray(args?.groups)
        ? args.groups.filter((item) => typeof item === 'string' && item.length > 0)
        : []
      const requestedNames = Array.isArray(args?.toolNames)
        ? args.toolNames.filter((item) => typeof item === 'string' && item.length > 0)
        : []
      const lines = []

      let schemas = []
      try {
        // 执行者就是观察 scope：preset 层注册的工具要按 agent 查才看得见。
        // 组展开也只使用这份实际目录，绝不绕 scope 解锁不可访问工具。
        schemas = ctx.tools.schemas(exec?.agent) ?? []
      } catch (error) {
        lines.push(`目录不可用：${String((error && error.message) || error)}`)
      }
      const session = exec?.agent?.session
      const resolved = resolveToolRequest({ toolNames: requestedNames, groups: requestedGroups }, schemas)

      if (resolved.accepted.length > 0) {
        if (session === undefined) {
          lines.push(`未解锁：当前没有可持久化的会话（exec.agent.session 不存在），accepted 为空。请在有会话的请求中重试；本次不会返回解锁名单。`)
        } else {
          const entry = entryFor(session)
          for (const toolName of resolved.accepted) entry.unlocked.add(toolName)
          lines.push(`已解锁（下一次请求起可见）：${resolved.accepted.join(', ')}`)
        }
      }
      if (resolved.missingNames.length > 0) {
        lines.push(`未找到：${resolved.missingNames.join(', ')} —— 用 query 搜一下确认名字，或检查组是否在当前作用域。`)
      }
      if (resolved.unknownGroups.length > 0) {
        lines.push(`未知组：${resolved.unknownGroups.join(', ')} —— 可用组：${Object.keys(TOOL_GROUPS).join(', ')}。其余合法项已继续处理。`)
      }
      if (resolved.emptyGroups.length > 0) {
        lines.push(`组在当前目录没有可解锁工具：${resolved.emptyGroups.join(', ')}（可能未安装或不在本 session scope）。`)
      }

      if (query.length > 0) {
        const tokens = query.toLowerCase().split(/[^a-z0-9_\u4e00-\u9fff]+/u).filter(Boolean)
        const ranked = schemas
          .map((schema) => ({ schema, score: scoreTool(schema, tokens) }))
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score || String(a.schema.name).localeCompare(String(b.schema.name)))
        if (ranked.length === 0) {
          lines.push(`没有匹配「${query}」的工具。空结果不等于不存在：确知名字时直接 dev_tool_search({toolNames:["..."]})。`)
        } else {
          const shown = ranked.slice(0, maxSearchResults)
          lines.push(`匹配工具（${shown.length}${ranked.length > shown.length ? ` / ${ranked.length}` : ''}）：`)
          for (const { schema } of shown) {
            const locked = !runtime.resident.has(schema.name) && !(session !== undefined && (runtime.state.get(session.id)?.unlocked.has(schema.name) ?? false))
            const description = String(schema.description ?? '').split('\n')[0].slice(0, 90)
            lines.push(`- ${schema.name}${locked ? ' [未解锁]' : ''}：${description}`)
          }
          lines.push('用 dev_tool_search({"toolNames":["<精确名>"]}) 或 {"groups":["office"]} 解锁。')
        }
      }

      if (requestedNames.length === 0 && requestedGroups.length === 0 && query.length === 0) {
        const unlocked = session !== undefined ? (runtime.state.get(session.id)?.unlocked.size ?? 0) : 0
        const gateMode = currentGateMode(session)
        lines.push(`门控模式：${gateMode}`)
        lines.push(`常驻：${runtime.resident.size} 个；已解锁：${unlocked} 个；目录总数：${schemas.length} 个`)
        lines.push('固定工具组（用 groups 解锁，只展开当前目录实际存在的名字）：')
        for (const [groupName, group] of Object.entries(TOOL_GROUPS)) {
          lines.push(`- ${groupName}：${group.description}`)
        }
        if (gateMode === 'full') lines.push('当前为全量模式：所有工具本来就可见，本工具的解锁操作不会改变可见性。')
      }

      return { text: lines.join('\n'), accepted: session === undefined ? [] : resolved.accepted }
    },
  })
}
