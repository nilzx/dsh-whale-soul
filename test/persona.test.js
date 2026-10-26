import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

test('persona mirrors the user language in both preset copies', () => {
  assert.equal((patch.match(/LANG_MIRROR_USER/g) ?? []).length, 2)
  assert.equal((patch.match(/REASON_IN_USER_LANG/g) ?? []).length, 2)
  assert.equal((patch.match(/## 语言/g) ?? []).length, 2)
  assert.doesNotMatch(patch, /LANG_ZH_CN_ONLY|全中文回复/)
  assert.match(patch, /思考、推理、计划和工具调用前的判断/)
  assert.match(patch, /不要因为这段设定是中文写的就固定用中文/)
})
