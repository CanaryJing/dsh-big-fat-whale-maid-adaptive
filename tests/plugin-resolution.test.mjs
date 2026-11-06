import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const anchor = process.env.DSH_TEST_ANCHOR

/**
 * Every `name:` row in the bundle patch must be a module specifier the host
 * loader can actually import. dsh 0.2.2 merged the standalone `list-agents`
 * plugin into `@deepseek-ai/dsh-tool-subagent-control`, so the old
 * `.../list-agents` subpath stopped resolving and that row failed at mount
 * with `never started`. Resolving every row against the anchored runtime makes
 * the next upstream merge fail here instead of in a user's mount audit.
 *
 * Run with: DSH_TEST_ANCHOR=/path/to/installed/dsh npm test
 */
test('every plugin row in cordis.patch.yml resolves in the anchored dsh runtime', { skip: !anchor }, () => {
  const yaml = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const names = [...yaml.matchAll(/^\s*name:\s*'([^']+)'/gm)]
    .map(match => match[1])
    // The preset declaration itself carries a display name, not a specifier.
    .filter(name => name.startsWith('@') || name.includes('/'))
    .filter(name => !name.startsWith('cordis:'))
  assert.ok(names.length > 0, 'cordis.patch.yml must declare plugin rows')
  const require = createRequire(resolve(anchor, 'package.json'))
  const unresolved = names.filter(name => {
    try {
      require.resolve(name)
      return false
    } catch {
      return true
    }
  })
  assert.deepEqual(unresolved, [], `unresolvable plugin rows: ${unresolved.join(', ')}`)
})
