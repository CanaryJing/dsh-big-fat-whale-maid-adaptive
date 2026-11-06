import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * dsh >= 0.2.2 replaced the per-scope `tools.presentAs()` declaration with
 * mounted executor plugins (`@deepseek-ai/dsh-tool-executor-native` /
 * `-ptc`); `tools.modeFor()` and `tools.sdkSchemas()` were removed with it.
 * The band-switching behavioural suites pin the 0.2.1 API, so they can only run
 * against a 0.2.1 runtime. Porting the preset's three bands onto the executor
 * model is tracked for the next feature release, not this compatibility fix.
 *
 * @param anchor - profile or runtime root that resolves `@deepseek-ai/dsh-tools`.
 * @returns whether the anchored runtime still exposes the 0.2.1 presentation API.
 */
export function supportsLegacyPresentation(anchor) {
  if (!anchor) return false
  try {
    const require = createRequire(resolve(anchor, 'package.json'))
    return readFileSync(require.resolve('@deepseek-ai/dsh-tools'), 'utf8').includes('presentAs')
  } catch {
    return false
  }
}
