import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { apply, setGateMode, describeGate, GATE_TOOL } from '../tool-gate.mjs'
const anchor=process.env.DSH_TEST_ANCHOR
const definition=name=>({name,description:name,parameters:{type:'object',properties:{}},output:{schema:{type:'object',properties:{}},render:()=>[]},async execute(){return {}}})

test('PTC high gates inherited SDK/execution, preserves run_code, next-run unlock, max and two sessions', {skip:!anchor}, async()=>{
 const require=createRequire(resolve(anchor,'package.json'))
 const load=name=>import(pathToFileURL(require.resolve(name)).href)
 const {Context}=await load('@deepseek-ai/cordis')
 const {SystemPrompt}=await load('@deepseek-ai/dsh-system-prompt')
 const {ToolRuntime}=await load('@deepseek-ai/dsh-tools')
 const {createScope}=await load('@deepseek-ai/dsh-scope')
 const root=new Context();const prompt=new SystemPrompt(root,{includeHarnessIdentity:false});const tools=new ToolRuntime(root,{})
 root.provide('ptcRuntime',{language:'typescript',programFormat:'function-body'})
 const presetKey={}; const preset=createScope(root,presetKey)
 const a={session:{id:'ptc-a',header:{},events:[]}}, b={session:{id:'ptc-b',header:{},events:[]}}
 const sa=createScope(root,a,{parent:presetKey}), sb=createScope(root,b,{parent:presetKey});a.ctx=sa.ctx;b.ctx=sb.ctx
 try {
  preset.ctx.tools.register(definition('read'));preset.ctx.tools.register(definition('office_open'));preset.ctx.tools.register(definition('office_forbidden'))
  apply(preset.ctx,{mode:'progressive',residentTools:['read']})
  sa.ctx.tools.presentAs('ptc');sb.ctx.tools.presentAs('ptc')
  const external=sa.ctx.tools.restrict({deny:['office_forbidden']})
  const assemble=agent=>prompt.assemble({scope:agent,agent})
  const first=await assemble(a)
  assert.deepEqual(first.tools.map(t=>t.name),['run_code'])
  assert.ok(tools.sdkSchemas(a).some(t=>t.name===GATE_TOOL))
  assert.ok(!tools.sdkSchemas(a).some(t=>t.name==='office_open'))
  assert.equal(tools.resolveExecution('office_open',a,true),undefined)
  assert.ok(tools.resolveExecution('run_code',a,false))
  const gate=tools.get(GATE_TOOL,a)
  const search=await gate.execute({query:'office_open'},{agent:a})
  assert.ok(search.text.includes('office_open [未解锁]'))
  const forbidden=await gate.execute({toolNames:['office_forbidden']},{agent:a})
  assert.deepEqual(forbidden.accepted,[],'discovery must retain external restrictions')
  await gate.execute({toolNames:['office_open']},{agent:a})
  assert.equal(tools.resolveExecution('office_open',a,true),undefined,'unlock does not change current bindings')
  await assemble(a)
  assert.ok(tools.sdkSchemas(a).some(t=>t.name==='office_open'))
  assert.ok(tools.resolveExecution('office_open',a,true))
  await assemble(b)
  assert.equal(tools.resolveExecution('office_open',b,true),undefined,'session isolation')
  setGateMode('full',{session:a.session});await assemble(a)
  assert.ok(tools.sdkSchemas(a).some(t=>t.name==='office_open'))
  assert.equal(tools.resolveExecution('office_forbidden',a,true),undefined,'max never lifts external restrictions')
  assert.doesNotMatch((await gate.execute({query:'office_open'},{agent:a})).text,/未解锁/)
  setGateMode('progressive',{session:a.session});await assemble(a)
  assert.deepEqual(tools.wireSchemas(a).schemas.map(t=>t.name),['run_code'])
  external()
 } finally {await sa.dispose();await sb.dispose();await preset.dispose()}
})

test('PTC cold recovery requires successful paired parent/root/subcall metadata',()=>{
 apply({on(){},tools:{register(){},schemas(){return []}}},{residentTools:['read']})
 const meta={gate:GATE_TOOL,accepted:['office_open']}
 const start={type:'tool/ptc-dispatch-start',data:{name:GATE_TOOL,rootCallId:'root',parentCallId:'outer',subCallId:'sub',arguments:{groups:['office']}}}
 const done={type:'tool/ptc-dispatch',data:{...start.data,isError:false,meta,content:[]}}
 const recover=(id,events)=>describeGate({session:{id,header:{},events}})
 assert.match(recover('paired',[start,done]),/unlocked=1/)
 assert.match(recover('orphan',[done]),/unlocked=0/)
 assert.match(recover('interrupted',[start]),/unlocked=0/)
 assert.match(recover('failed',[start,{...done,data:{...done.data,isError:true}}]),/unlocked=0/)
 assert.match(recover('wrong-parent',[start,{...done,data:{...done.data,parentCallId:'other'}}]),/unlocked=0/)
 assert.match(recover('wrong-root',[start,{...done,data:{...done.data,rootCallId:'other'}}]),/unlocked=0/)
 assert.match(recover('empty',[start,{...done,data:{...done.data,meta:{gate:GATE_TOOL,accepted:[]}}}]),/unlocked=0/)
})
