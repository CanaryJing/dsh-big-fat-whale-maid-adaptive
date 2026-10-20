import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const patch = readFileSync(resolve(here, '..', 'cordis.patch.yml'), 'utf8')

test('persona prefix requires thinking in Chinese and keeps complete:false', () => {
  const personaRow = patch.indexOf('- id: persona')
  assert.ok(personaRow > 0, 'persona row must exist')

  const prefix = patch.indexOf('prefix: |-', personaRow)
  const complete = patch.indexOf('complete: false', prefix)
  assert.ok(prefix > 0, 'persona prefix must exist')
  assert.ok(complete > prefix, 'persona must stay complete:false so ENV/MODEL sections survive')

  const body = patch.slice(prefix, complete)
  const rule = body
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('- Reasoning language:'))
  assert.ok(rule, 'persona must carry the reasoning-language rule')
  assert.match(rule, /think in Chinese \(简体中文\)/, 'rule must name Simplified Chinese reasoning')
  assert.match(rule, /not silently in another language/)
  assert.match(rule, /original language/, 'code/paths/logs stay in their source language')
  assert.ok(body.indexOf('- Reasoning language:') < body.indexOf('- Use the [ENV]'), 'rule precedes env/shell rules')
})
