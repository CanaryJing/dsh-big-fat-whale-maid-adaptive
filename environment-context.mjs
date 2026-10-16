/** Persistent, scoped environment facts and live model routing identity. */
export function registerEnvironmentContext(ctx, { getSnapshot, ready, describe }) {
  // Declare a variable so DSH knows it; its final value is supplied below after
  // async detection. Substituted values are never scanned for {{...}} again.
  ctx.effect(() => ctx.systemPrompt.variable('whale_environment', () => ''))
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'whale-maid:environment',
    order: 10,
    text: ({ agent }) => agent === undefined ? '' : [
      '{{whale_environment}}',
      '[MODEL] current DSH request route: model={{model}}; provider={{provider}}.',
      'These are current routing IDs, not a verified upstream model identity; a proxy/provider may remap them.',
    ].join('\n'),
  }))

  // Assembly happens BEFORE agent/pre-step. Never probe from a synchronous
  // variable provider, re-assemble recursively, or cache model from agent.options:
  // the UI can change the model without updating those initial options.
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    if (context.agent === undefined) return assembled
    const snapshot = getSnapshot() ?? (await ready)
    return {
      ...assembled,
      variables: { ...assembled.variables, whale_environment: describe(snapshot, context) },
    }
  })
}
