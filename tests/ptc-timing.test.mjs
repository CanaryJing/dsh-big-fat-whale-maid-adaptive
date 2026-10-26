import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { apply as gateApply, GATE_TOOL } from '../tool-gate.mjs'
import { apply as effortApply } from '../effort-policy.mjs'
const anchor=process.env.DSH_TEST_ANCHOR
const tool=name=>({name,description:name,parameters:{type:'object',properties:{}},output:{schema:{type:'object',properties:{}},render:()=>[]},async execute(){return {}}})
for(const initial of ['low','high','max']) for(const order of ['effort-first','gate-first']) {
 test('real first '+initial+' and live transitions ('+order+')',{skip:!anchor},async()=>{
  const require=createRequire(resolve(anchor,'package.json'))
  const load=name=>import(pathToFileURL(require.resolve(name)).href)
  const {Context}=await load('@deepseek-ai/cordis')
  const {SystemPrompt}=await load('@deepseek-ai/dsh-system-prompt')
  const {ToolRuntime}=await load('@deepseek-ai/dsh-tools')
  const {createScope}=await load('@deepseek-ai/dsh-scope')
  const root=new Context(), prompt=new SystemPrompt(root,{includeHarnessIdentity:false}), registry=new ToolRuntime(root,{})
  root.provide('ptcRuntime',{language:'typescript',programFormat:'function-body'})
  const parent={}; const preset=createScope(root,parent)
  const agent={options:{reasoningEffort:initial},session:{id:initial+order,header:{},events:[]}}
  const scope=createScope(root,agent,{parent});agent.ctx=scope.ctx
  try {
   for(const name of ['read','extra_capability','extra_other','external_denied'])preset.ctx.tools.register(tool(name))
   const gate=()=>gateApply(preset.ctx,{residentTools:['read']})
   if(order==='effort-first'){effortApply(preset.ctx,{});gate()}else{gate();effortApply(preset.ctx,{})}
   scope.ctx.tools.restrict({deny:['external_denied']})
   const observations=[]
   const check=async band=>{
    const assembled=await prompt.assemble({scope:agent,agent})
    const wire=assembled.tools.map(t=>t.name)
    const sdk=assembled.sections.filter(s=>s.name==='tools:sdk').map(s=>s.text).join('')
    assert.match(assembled.sections.find(s=>s.name==='whale-maid:effort').text,new RegExp('band='+band))
    if(band==='low'){
     assert.ok(!wire.includes('run_code'))
     assert.ok(wire.includes('read')&&wire.includes(GATE_TOOL))
     assert.equal(sdk,'')
     assert.equal(registry.modeFor(agent),'native')
    }else{
     assert.deepEqual(wire,['run_code'],'PTC entry required in THIS snapshot, including first request')
     assert.equal(registry.modeFor(agent),'ptc')
     assert.ok(registry.resolveExecution('run_code',agent,false))
     assert.ok(sdk.includes(GATE_TOOL),'SDK must be present in THIS snapshot')
     assert.equal(sdk.includes('extra_other'),band==='max','SDK cannot lag a band behind')
     assert.equal(!!registry.resolveExecution('extra_other',agent,true),band==='max')
    }
    assert.ok(!sdk.includes('external_denied'))
    assert.equal(registry.resolveExecution('external_denied',agent,true),undefined)
    observations.push({band,wire,extraInSdk:sdk.includes('extra_other')})
    return assembled
   }
   await check(initial) // NO presentAs call or warm-up before this assertion.
   for(const band of ['max','high','low','high','max','max']){agent.options.reasoningEffort=band;await check(band)}
   for(const band of ['high','max','low','max']){agent.session.events.push({type:'model/selection',data:{reasoningEffort:band}});await check(band)}
   agent.session.events.push({type:'model/selection',data:{reasoningEffort:'high'}});await check('high')
   const gateTool=registry.get(GATE_TOOL,agent)
   const result=await gateTool.execute({toolNames:['extra_capability']},{agent})
   assert.deepEqual(result.accepted,['extra_capability'])
   assert.equal(registry.resolveExecution('extra_capability',agent,true),undefined,'current run stays locked')
   const next=await check('high')
   assert.ok(next.sections.find(s=>s.name==='tools:sdk').text.includes('extra_capability'))
   assert.ok(registry.resolveExecution('extra_capability',agent,true))
   console.log(JSON.stringify({initial,order,first:observations[0],snapshotsChecked:observations.length}))
  }finally{await scope.dispose();await preset.dispose()}
 })
}
