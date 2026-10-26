/**
 * DeepSeek Messages rejects a declaration list containing only deferred tools.
 * Native -> PTC on an addition-only route creates exactly that list. Mirror
 * dsh-llm-pi-ai's Anthropic transport placeholder, AFTER core tool projection.
 * Never mutate a frozen agent request, session history or an active tool schema.
 * This bundle-level shim decorates only the public DeepSeek adapter entrypoints;
 * it does not edit installed engine files or wrap the global fetch function.
 */
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'whale-maid-deferred-tools-compat'
export const inject = ['llm']
export const ANCHOR_NAME = 'WhaleMaidDeferredToolAnchor'
const INSTALLATION = Symbol.for('dsh.whale-maid.deferred-tools-compat.v1')

/** Return the ORIGINAL object for unaffected requests; clone only the tool list. */
export function withDeferredToolAnchor(options) {
  const tools = options?.tools
  if (!Array.isArray(tools) || tools.length === 0
      || !tools.every(tool => tool?.deferLoading === true)) return options
  const names = new Set(tools.map(tool => tool.name))
  let name = ANCHOR_NAME
  for (let suffix = 1; names.has(name); suffix++) name = `${ANCHOR_NAME}_${suffix}`
  const anchor = Object.freeze({
    name,
    description: 'Reserved transport placeholder for deferred tool declarations. Never call this tool; use only the tools activated in the conversation.',
    parameters: Object.freeze({ type: 'object', properties: Object.freeze({}), additionalProperties: false }),
  })
  // Keep all real tools deferred. In particular run_code is NOT made available
  // ahead of its recorded tool-addition. All message blocks stay byte-for-byte.
  return { ...options, tools: [anchor, ...tools] }
}

/** Ref-counted and reversible across bundle reloads; preserve prepared snapshots. */
export function installAdapterGuard(Adapter) {
  const proto = Adapter?.prototype
  if (typeof proto?.prepareCall !== 'function' || typeof proto?.stream !== 'function') {
    throw new TypeError(`${name}: DeepSeek adapter lacks prepareCall/stream`)
  }
  let state = Object.hasOwn(proto, INSTALLATION) ? proto[INSTALLATION] : undefined
  if (state === undefined) {
    const prepareDescriptor = Object.getOwnPropertyDescriptor(proto, 'prepareCall')
    const streamDescriptor = Object.getOwnPropertyDescriptor(proto, 'stream')
    const originalPrepare = proto.prepareCall
    const originalStream = proto.stream
    const guardedPrepare = async function (...args) {
      const call = await originalPrepare.apply(this, args)
      return { ...call, stream: options => call.stream(withDeferredToolAnchor(options)) }
    }
    const guardedStream = function (options, ...rest) {
      return originalStream.call(this, withDeferredToolAnchor(options), ...rest)
    }
    Object.defineProperty(proto, 'prepareCall', { configurable: true, writable: true, value: guardedPrepare })
    Object.defineProperty(proto, 'stream', { configurable: true, writable: true, value: guardedStream })
    state = { refs: 0, prepareDescriptor, streamDescriptor, guardedPrepare, guardedStream }
    Object.defineProperty(proto, INSTALLATION, { configurable: true, value: state })
  }
  state.refs++
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    if (--state.refs !== 0) return
    // Do not tear down another extension which has replaced our entrypoints.
    // That extension may still delegate to us. A later install detects this.
    if (proto.prepareCall !== state.guardedPrepare || proto.stream !== state.guardedStream) return
    if (state.prepareDescriptor) Object.defineProperty(proto, 'prepareCall', state.prepareDescriptor)
    else delete proto.prepareCall
    if (state.streamDescriptor) Object.defineProperty(proto, 'stream', state.streamDescriptor)
    else delete proto.stream
    delete proto[INSTALLATION]
  }
}

/** Resolve from the RUNNING engine entry, never the linked preset's node_modules. */
export async function apply(ctx, config = {}) {
  if (Object.keys(config).length > 0) throw new TypeError(`${name}: no configuration keys are supported`)
  const entry = process.argv[1]
  if (typeof entry !== 'string' || !isAbsolute(entry)) {
    throw new Error(`${name}: cannot identify the running engine entry`)
  }
  const require = createRequire(entry)
  let adapterPath
  try {
    adapterPath = require.resolve('@deepseek-ai/dsh-llm-deepseek')
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND' && error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error
    // Older engines do not have the new DeepSeek Messages transport/update path.
    ctx.logger?.warn(`${name}: inactive — this engine has no DeepSeek Messages adapter`)
    return
  }
  const { LlmRuntime } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href)
  if (!(ctx.llm instanceof LlmRuntime)) {
    throw new Error(`${name}: entry resolves a different LLM runtime; refusing to patch the wrong engine`)
  }
  const { DeepSeekAdapter } = await import(pathToFileURL(adapterPath).href)
  // ctx.effect disposes the prototype decoration on bundle unload/HMR. It is
  // mounted once at bundle scope, NOT inside any particular agent preset.
  ctx.effect(() => installAdapterGuard(DeepSeekAdapter))
}
