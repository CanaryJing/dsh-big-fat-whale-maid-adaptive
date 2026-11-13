/** DSH 0.2.2 executor selection, without modifying the engine or shared registry. */
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { filterGateDefinitions } from './tool-gate.mjs'

/** Resolve executor classes from the running engine, not this package's install tree. */
export async function loadExecutorFactory(ctx) {
  const entry = process.argv[1]
  if (typeof entry !== 'string' || !isAbsolute(entry)) {
    throw new Error('effort-policy: cannot identify the running engine entry')
  }
  const require = createRequire(entry)
  const load = name => import(pathToFileURL(require.resolve(name)).href)
  const [{ ToolsService }, { NativeToolExecutor }, { PtcExecutor }] = await Promise.all([
    load('@deepseek-ai/dsh-tools'),
    load('@deepseek-ai/dsh-tool-executor-native'),
    load('@deepseek-ai/dsh-tool-executor-ptc'),
  ])
  if (!(ctx.tools instanceof ToolsService)) {
    throw new Error('effort-policy: entry resolves a different tools runtime')
  }
  return agent => createEffortExecutor(agent, { NativeToolExecutor, PtcExecutor })
}

/** One stable executor per agent. A step's SDK and program bindings share a snapshot. */
export function createEffortExecutor(agent, { NativeToolExecutor, PtcExecutor }) {
  const ctx = agent.ctx
  const native = new NativeToolExecutor(ctx)
  const ptc = new PtcExecutor(ctx)
  const snapshots = new WeakMap()
  let latest
  const capture = (presentation, toolSet) => ({
    presentation,
    names: new Set(filterGateDefinitions(agent, ctx.tools.definitions(agent, toolSet)).map(tool => tool.name)),
  })
  const snapshotFor = toolSet => (toolSet && snapshots.get(toolSet)) ?? latest
  const executor = {
    // Native mode emits no PTC sections. SDK names use the same admitted set
    // as execution; discovery still sees the original unrestricted registry.
    sections: ptc.sections.map(section => ({
      ...section,
      text: definitions => {
        if (latest?.presentation !== 'ptc') return ''
        const visible = definitions.filter(tool => latest.names.has(tool.name))
        return typeof section.text === 'function' ? section.text(visible) : section.text
      },
    })),
    describe(definitions) {
      return (latest?.presentation === 'ptc' ? ptc : native).describe(
        latest ? definitions.filter(tool => latest.names.has(tool.name)) : definitions,
      )
    },
    execute(input) {
      const snapshot = snapshotFor(input.toolSet)
      if (snapshot?.presentation !== 'ptc') return native.execute(input)
      const admitted = input.toolSet
      // Intersect the immutable gate snapshot with the engine's LIVE admitted
      // view. Never re-admit conditional, removed or ancestor-denied tools.
      const toolSet = {
        view(scope) {
          const view = admitted?.view(scope) ?? new Map(ctx.tools.definitions(scope).map(tool => [tool.name, tool]))
          return new Map([...view].filter(([name]) => snapshot.names.has(name)))
        },
        dispose() {}, // the agent loop owns disposal of the original selection
      }
      return ptc.execute({ ...input, toolSet })
    },
  }
  const dispose = ctx.tools.setExecutor(executor)
  return {
    update(presentation, toolSet) {
      latest = capture(presentation, toolSet)
      if (toolSet) snapshots.set(toolSet, latest)
    },
    dispose,
  }
}
