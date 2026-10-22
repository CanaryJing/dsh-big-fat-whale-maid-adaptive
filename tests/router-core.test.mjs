import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MODE_SPEC, MODE_REACT, MODE_WEAK, MODE_CONSULT,
  bandOf, bandFor, overlayFor, coreFor, testinessFor, parseMode,
  classifyTask, sessionMode, sessionRequestText, extractText,
  extractUserRequestText, isHumanUserMessage, isBareAcknowledgement,
} from '../router-core.mjs'

function user(data, source = { kind: 'user' }) {
  return { type: 'user/message', data: { source, ...data } }
}

function textMessage(text, source) {
  return user({ content: [{ type: 'text', text }] }, source ?? { kind: 'user' })
}

function session(events, id = 'router-session') {
  return { id, header: { cwd: 'D:\\workspace' }, events }
}

test('latest real user request wins; earlier dev request does not pin react', () => {
  const s = session([
    textMessage('请创建一个网页'),
    textMessage('下面是插件注入的上下文', { kind: 'plugin' }),
    textMessage('请解释这段代码'),
  ])
  assert.equal(sessionMode(s), MODE_CONSULT)
  assert.equal(sessionRequestText(s), '请解释这段代码')
})

test('first consult then last implementation routes to implementation', () => {
  const s = session([
    textMessage('先解释这个设计'),
    textMessage('请实现登录页'),
  ])
  assert.equal(sessionMode(s), MODE_REACT)
})

test('extractText and sessionMode accept data.content, message.content and legacy text', () => {
  assert.equal(sessionMode(session([user({ content: [{ type: 'text', text: '修复登录 bug' }] })])), MODE_SPEC)
  assert.equal(sessionMode(session([user({ message: { content: [{ type: 'text', text: '创建网页' }] } })])), MODE_REACT)
  assert.equal(sessionMode(session([user({ text: '解释这个函数' })])), MODE_CONSULT)
  assert.equal(extractText({ message: { content: 'legacy string' } }), 'legacy string')
  assert.equal(extractText({ content: ['plain', { text: 'block' }] }), 'plain\nblock')
})

test('automatic sources are excluded, including plugin, model-selection and user-approval', () => {
  assert.equal(sessionMode(session([
    textMessage('build a new project', { kind: 'plugin' }),
    textMessage('implement everything', { kind: 'plugin:openviking' }),
    textMessage('agent message', { kind: 'agent-message' }),
    textMessage('switch model', { kind: 'model-selection' }),
    textMessage('approved', { kind: 'user-approval' }),
  ])), MODE_WEAK)
  assert.equal(isHumanUserMessage({ source: { kind: 'plugin' } }), false)
  assert.equal(isHumanUserMessage({ source: { kind: 'plugin:foo' } }), false)
  assert.equal(isHumanUserMessage({ source: { kind: 'agent-message' } }), false)
  assert.equal(isHumanUserMessage({ source: { kind: 'model-selection' } }), false)
  assert.equal(isHumanUserMessage({ source: { kind: 'user-approval' } }), false)
  assert.equal(isHumanUserMessage({}), true, 'legacy data without source stays eligible')
  assert.equal(isHumanUserMessage({ source: { kind: 'user' } }), true)
  assert.equal(sessionMode(session([
    textMessage('implement it', { kind: 'model-selection' }),
    textMessage('修复这个 bug'),
  ])), MODE_SPEC)
})

test('openviking/runtime wrappers are stripped but the real request outside them is kept', () => {
  const wrapped = textMessage([
    '<openviking-context>',
    'memory: build create implement refactor',
    '</openviking-context>',
    '请解释这段代码',
  ].join('\n'))
  assert.equal(sessionMode(session([wrapped])), MODE_CONSULT)
  assert.equal(extractUserRequestText(wrapped.data), '请解释这段代码')

  const mixed = textMessage('请实现登录页\n<openviking-memory>build create implement</openviking-memory>')
  assert.equal(sessionMode(session([mixed])), MODE_REACT)

  assert.equal(sessionMode(session([
    textMessage('<openviking-context>implement build create</openviking-context>'),
  ])), MODE_WEAK)
  assert.equal(sessionMode(session([
    textMessage('[runtime-context] build create implement [/runtime-context]'),
  ])), MODE_WEAK)
})

test('short acknowledgements continue the previous substantive task style', () => {
  for (const ack of ['继续', '好的', '可以', '继续吧', 'OK', '好的，继续']) {
    assert.equal(isBareAcknowledgement(ack), true, ack)
    assert.equal(sessionMode(session([textMessage('创建网页'), textMessage(ack)])), MODE_REACT, ack)
    assert.equal(sessionMode(session([textMessage('修复登录页'), textMessage(ack)])), MODE_SPEC, ack)
    assert.equal(sessionMode(session([textMessage('解释这段代码'), textMessage(ack)])), MODE_CONSULT, ack)
  }
  assert.equal(isBareAcknowledgement('好的，继续实现登录页'), false)
  assert.equal(sessionMode(session([textMessage('好的，继续实现登录页')])), MODE_REACT)
  assert.equal(sessionMode(session([textMessage('继续')])), MODE_WEAK, 'no previous substantive task')
  assert.equal(sessionMode(session([])), MODE_WEAK)
})

test('consult covers explanation, review, read-only and plan-first without blocking real implementation', () => {
  assert.equal(classifyTask('不要实现，只解释这段代码'), MODE_CONSULT)
  assert.equal(classifyTask('先给我计划，不要写代码'), MODE_CONSULT)
  assert.equal(classifyTask('只给方案，不修改文件'), MODE_CONSULT)
  assert.equal(classifyTask('给我一个计划'), MODE_CONSULT)
  assert.equal(classifyTask('请评审这个设计'), MODE_CONSULT)
  assert.equal(classifyTask('只读检查一下仓库结构'), MODE_CONSULT)
  assert.notEqual(classifyTask('按计划实现修复'), MODE_CONSULT, 'implementation language wins over the bare word 计划')
  assert.equal(classifyTask('按计划实现修复'), MODE_SPEC, 'explicit implementation must enter react/spec, not stay weak')
  assert.equal(classifyTask('请修复这个 bug'), MODE_SPEC)
  assert.equal(classifyTask('帮我实现登录页'), MODE_REACT)
  assert.equal(classifyTask('不需要修复，也不实现'), MODE_WEAK, 'negated implementation verbs alone are not an implementation request')
  assert.equal(classifyTask('解释如何修复这个 bug'), MODE_CONSULT)
  assert.equal(classifyTask('解释并修复这个 bug'), MODE_SPEC, 'coordinated implementation keeps implementation mode')
})

test('English consult vs implementation and quote/code injection', () => {
  assert.equal(classifyTask('Please explain this function'), MODE_CONSULT)
  assert.equal(classifyTask('Review this design; do not write code'), MODE_CONSULT)
  assert.equal(classifyTask('review the code'), MODE_CONSULT)
  assert.equal(classifyTask('review and fix the code'), MODE_SPEC)
  assert.equal(classifyTask('Implement the login page'), MODE_REACT)
  assert.equal(classifyTask('Fix the failing test'), MODE_SPEC)

  const codeOnly = textMessage('```js\n// build create implement\nfunction x() {}\n```\n请只解释这段代码')
  assert.equal(sessionMode(session([codeOnly])), MODE_CONSULT)
  const quoted = textMessage('> implement and build everything\n\n请实现登录页')
  assert.equal(sessionMode(session([quoted])), MODE_REACT)
  assert.equal(classifyTask('> build create implement'), MODE_WEAK)
  assert.equal(classifyTask('```\nbuild create implement\n```'), MODE_WEAK)
})

test('no reliable intent is neutral weak, not react', () => {
  for (const text of ['', '   ', '你好', '谢谢', '嗯', '今天天气不错', '好的', '这个工具不错', '脚本', '网页']) {
    assert.equal(classifyTask(text), MODE_WEAK, JSON.stringify(text))
  }
})

test('existing numeric/weak exports and consult-supported helpers stay compatible', () => {
  assert.equal(MODE_SPEC, 0)
  assert.equal(MODE_REACT, 1)
  assert.equal(MODE_WEAK, 'weak')
  assert.equal(MODE_CONSULT, 'consult')
  assert.equal(bandOf(0), 'spec')
  assert.equal(bandOf(0.3), 'transition')
  assert.equal(bandOf(1), 'react')
  assert.equal(bandOf('weak'), 'weak')
  assert.equal(bandOf('consult'), 'consult')
  assert.equal(bandFor(0.3), 'mixed')
  assert.equal(bandFor('consult'), 'consult')
  assert.deepEqual(coreFor('consult'), ['read', 'glob', 'grep'])
  assert.equal(testinessFor('consult'), 'normal')
  assert.match(overlayFor('consult'), /Task mode \(consult\)/)
  assert.doesNotMatch(overlayFor('consult'), /write or edit code/)
  assert.match(overlayFor('consult'), /grants? no permissions|permission/i)
  assert.match(overlayFor(1), /Task mode \(react\)/)
  assert.match(overlayFor('weak', 'deepseek-flash'), /do not run environment checks/i)
  assert.equal(parseMode('spec'), 0)
  assert.equal(parseMode('consult'), 'consult')
  assert.equal(parseMode('weak'), 'weak')
  assert.equal(parseMode('50'), 0.5)
  assert.equal(parseMode('0.25'), 0.25)
  assert.equal(parseMode('nonsense'), null)
})
