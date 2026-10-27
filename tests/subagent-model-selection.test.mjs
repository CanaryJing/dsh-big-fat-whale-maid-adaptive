import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

for (const file of ['agent.cordis.yml', 'cordis.patch.yml']) {
  test(`${file} enables model selection for spawn subagent only`, () => {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const match = text.match(/toolName: subagent\s*\n\s*modelSelectionSettings: true\s*\n\s*backgroundMode: continuable/g);
    assert.equal(match?.length, 1);
    assert.doesNotMatch(text, /toolName: subagent-fork\s*\n\s*modelSelectionSettings: true/);
  });
}
