/**
 * tool-gate — 女仆长 v3.0「全能但常驻精简」工具门控。
 *
 * 目标（2026-10-22 主人决定）：保留全部已注册工具的能力（全能），
 * 但不再每轮把整份目录塞进请求。做法：
 *
 *   1. 常驻核心（residentTools）：按历史 109 个会话 / 7255 次调用的实际
 *      分布挑出覆盖 90%+ 的高频工具，首轮可见；
 *   2. 其余工具按需解锁：模型调用 `dev_tool_search` 搜索或按名解锁，
 *      解锁记录写入持久会话事件，下一次请求起可见（恢复会话同样有效）；
 *   3. `mode: full` 一键回到旧的「全量首轮可见」，不卸载本插件即可回退。
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
  resident: new Set(),
  state: new Map(),
  includeSubagents: false,
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

/** 读一条 tool/call 事件里的解锁名单（arguments 可能是 JSON 字符串或对象）。 */
function unlockNamesFromEvent(event) {
  if (event?.type !== 'tool/call') return []
  const data = event.data
  if (data === undefined || data === null) return []
  if (data.name !== GATE_TOOL) return []
  const raw = data.arguments
  let args = raw
  if (typeof raw === 'string') {
    try {
      args = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (args === null || typeof args !== 'object') return []
  const names = Array.isArray(args.toolNames) ? args.toolNames : []
  return names.filter((item) => typeof item === 'string' && item.length > 0)
}

/** 冷启动扫一遍持久日志，重建该会话的解锁集合（恢复会话同样有效）。 */
function scanSession(session) {
  const events = typeof session.snapshotEvents === 'function'
    ? session.snapshotEvents()
    : (session.events ?? [])
  const unlocked = new Set()
  for (const event of events) {
    for (const toolName of unlockNamesFromEvent(event)) unlocked.add(toolName)
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
  if (runtime.mode === 'full') return 'full (all registered tools visible)'
  const session = agent?.session
  if (session === undefined) return `progressive (no session; resident=${runtime.resident.size})`
  const entry = runtime.state.get(session.id) ?? scanSession(session)
  return `progressive (resident=${runtime.resident.size}, unlocked=${entry.unlocked.size}, gate=${GATE_TOOL})`
}

function textOutput() {
  return {
    schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
    render: (_args, value) => [{ type: 'text', text: value.text }],
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

  // ── 增量维护解锁集合：工具执行完会记录 tool/call，下一次 assemble 生效 ──
  ctx.on('session/event', (session, event) => {
    if (session === undefined || event === undefined) return
    const names = unlockNamesFromEvent(event)
    if (names.length === 0) return
    const entry = entryFor(session)
    for (const toolName of names) entry.unlocked.add(toolName)
  })

  // ── 门控本体：只裁 tools，不动 sections ────────────────────────────────
  if (mode === 'progressive') {
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembled = await next()
      try {
        const session = context?.agent?.session
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
  }

  // ── 模型侧入口：搜索 + 解锁 ───────────────────────────────────────────
  ctx.tools.register({
    name: GATE_TOOL,
    description: [
      '发现并解锁当前**不可见**的工具。',
      '',
      '本会话只常驻一组高频核心工具（shell、文件读写、搜索、任务、技能、记忆读取、子代理协作）。其余工具仍然可用，但需要先通过本工具解锁：',
      '  • 传 `query` 搜索全量目录（返回匹配的工具名和一行描述）；',
      '  • 传 `toolNames`（精确名数组）解锁，下一次请求起可见，直到会话结束或压缩后仍保留；',
      '  • 两者可同时传：一次搜索 + 解锁。',
      '',
      '需要下列能力时，务必先搜索/解锁，不要用 bash 硬凑或宣称做不到：',
      ...UNLOCKABLE_INDEX.map((line) => `  - ${line}`),
      '',
      '注意：搜索为空只代表没有工具同时命中全部关键词，不代表工具不存在。确知名字时直接解锁：dev_tool_search({"toolNames":["office_open"]})。',
      '无参调用返回当前门控概览（常驻数量、已解锁数量）。',
    ].join('\n'),
    parameters: toJsonSchema({
      query: { type: 'string', required: false, description: '搜索关键词（1-2 个词最准，例如 "office"、"terminal"）' },
      toolNames: { type: 'array', required: false, items: { type: 'string' }, description: '按精确工具名解锁' },
    }),
    output: textOutput(),
    async execute(args, exec) {
      const query = typeof args?.query === 'string' ? args.query.trim() : ''
      const requested = Array.isArray(args?.toolNames)
        ? args.toolNames.filter((item) => typeof item === 'string' && item.length > 0)
        : []
      const lines = []

      let schemas = []
      try {
        // 执行者就是观察 scope：preset 层注册的工具要按 agent 查才看得见。
        schemas = ctx.tools.schemas(exec?.agent) ?? []
      } catch (error) {
        lines.push(`目录不可用：${String((error && error.message) || error)}`)
      }
      const known = new Set(schemas.map((schema) => schema.name))
      const session = exec?.agent?.session

      if (requested.length > 0) {
        const accepted = []
        const missing = []
        for (const toolName of requested) {
          if (known.has(toolName)) accepted.push(toolName)
          else missing.push(toolName)
        }
        if (accepted.length > 0 && session !== undefined) {
          const entry = entryFor(session)
          for (const toolName of accepted) entry.unlocked.add(toolName)
        }
        if (accepted.length > 0) lines.push(`已解锁（下一次请求起可见）：${accepted.join(', ')}`)
        if (missing.length > 0) lines.push(`未找到：${missing.join(', ')} —— 用 query 搜一下确认名字。`)
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
          lines.push('用 dev_tool_search({"toolNames":["<精确名>"]}) 解锁。')
        }
      }

      if (requested.length === 0 && query.length === 0) {
        const unlocked = session !== undefined ? (runtime.state.get(session.id)?.unlocked.size ?? 0) : 0
        lines.push(`门控模式：${mode}`)
        lines.push(`常驻：${runtime.resident.size} 个；已解锁：${unlocked} 个；目录总数：${schemas.length} 个`)
        if (mode === 'full') lines.push('当前为全量模式：所有工具本来就可见，本工具的解锁操作不会改变可见性。')
      }

      return { text: lines.join('\n') }
    },
  })
}
