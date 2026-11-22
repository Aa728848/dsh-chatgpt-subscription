import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {describe,expect,it} from 'vitest'
import type {StreamChunk} from '@deepseek-ai/dsh-llm'
import {AwsQuickAdapter} from '../src/host/aws-quick/adapter.ts'
import {AwsQuickSettingsStore} from '../src/host/aws-quick/settings.ts'
import type {AwsQuickOutpost} from '../src/host/aws-quick/outpost.ts'
import type {QuickConnection,QuickStreamEvent} from '../src/host/aws-quick/client.ts'
import type {AwsQuickToolBridge} from '../src/host/aws-quick/tool-bridge.ts'
async function collect(stream:AsyncIterable<StreamChunk>):Promise<StreamChunk[]>{const out:StreamChunk[]=[];for await(const chunk of stream)out.push(chunk);return out}
function request(text:string,tools:unknown[]=[],sessionId='s'):Record<string,unknown>{return{model:'quick-balanced',sessionId,messages:[{role:'user',content:[{type:'text',text}]}],tools}}
function fakeConnection(batches:QuickStreamEvent[][]){
 const state={closed:false,answers:[] as {result:unknown;isError:boolean}[],sent:'',attachments:undefined as unknown,policy:undefined as unknown};let subscribed:AbortSignal|undefined;let onAbort:()=>void
 const setSignal=(signal:AbortSignal|undefined)=>{if(subscribed&&onAbort)subscribed.removeEventListener('abort',onAbort);subscribed=signal;onAbort=()=>{state.closed=true};if(signal?.aborted)onAbort();else signal?.addEventListener('abort',onAbort,{once:true})}
 return{state,connection:{sendUser:(text:string,_mode:unknown,_effort:unknown,attachments:unknown,policy:unknown)=>{state.sent=text;state.attachments=attachments;state.policy=policy},setSignal,setActivity:()=>{},events:async function*(){const events=batches.shift()??[];for(const event of events)yield event},answerTool:(_call:unknown,result:unknown,isError=false)=>{state.answers.push({result,isError})},close:()=>{state.closed=true}} as unknown as QuickConnection}
}
const outpost={dispose:async()=>{}} as unknown as AwsQuickOutpost
async function cleanup(file:string){await fs.unlink(file).catch(()=>undefined);await fs.rmdir(path.dirname(file)).catch(()=>undefined)}
describe('AWS Quick adapter',()=>{
 it('maps reasoning/text/finish and reuses the Quick thread for the next user turn',async()=>{
  const file=path.join(await fs.mkdtemp(path.join(os.tmpdir(),'dsh-aws-quick-adapter-')),'settings.json')
  try{
   const inputs:{text:string;threadId:string}[]=[]
   const adapter=new AwsQuickAdapter({settings:new AwsQuickSettingsStore(file),outpost,openConnection:async(input)=>{const fake=fakeConnection([[{kind:'reasoning',delta:'think'},{kind:'text',delta:'answer'},{kind:'done',reason:'stop'}]]);inputs.push({get text(){return fake.state.sent},threadId:input.threadId});return fake.connection}})
   const first=await collect(adapter.stream(request('first') as never));expect(first.map((x)=>x.type)).toEqual(['block-start','reasoning-delta','block-end','block-start','text-delta','block-end','finish']);expect(first[2]).toMatchObject({block:{text:'think'}});expect(first[5]).toMatchObject({block:{text:'answer'}})
   const second=request('next') as {messages:Record<string,unknown>[]};second.messages=[{role:'user',content:[{type:'text',text:'first'}]},{role:'assistant',content:[{type:'text',text:'answer'}]},{role:'user',content:[{type:'text',text:'next'}]}]
   await collect(adapter.stream(second as never));expect(inputs[1].threadId).toBe(inputs[0].threadId);expect(inputs[1].text).toBe('next');await adapter.dispose()
  }finally{await cleanup(file)}
 })
 it('continues the same Quick connection with a real DSH tool result',async()=>{
  const file=path.join(await fs.mkdtemp(path.join(os.tmpdir(),'dsh-aws-quick-tools-')),'settings.json')
  try{
   const tool={name:'read',description:'Read file',parameters:{type:'object',properties:{}}}
   const first=fakeConnection([[{kind:'tool-call',call:{id:'call-1',name:'mcp__dsh_quick__read',argumentsText:'{"path":"a.ts"}'}}],[{kind:'text',delta:'done'},{kind:'done',reason:'stop'}]]);let opens=0
   const bridge={ensure:async()=>({id:'dsh-quick',fingerprint:'tools',outpostId:'official-outpost',resolve:(name:string)=>name==='mcp__dsh_quick__read'?'read':null}),track:()=>{},settle:()=>{},dispose:async()=>{}} as unknown as AwsQuickToolBridge
   const imageRef={attachmentId:'image-1',mediaType:'image/png',bytes:4,width:1,height:1,name:'pixel.png'};const attachments={readImage:async()=>({ref:imageRef,data:Uint8Array.from([1,2,3,4])}),readImageRequest:async()=>{throw new Error('unexpected scale')}}
   const adapter=new AwsQuickAdapter({settings:new AwsQuickSettingsStore(file),outpost,toolBridge:bridge,attachments:attachments as never,openConnection:async()=>{opens++;return first.connection}})
   const initial=await collect(adapter.stream(request('read a.ts',[tool]) as never));expect(initial.map((x)=>x.type)).toEqual(['block-start','tool-call-delta','block-end','finish']);expect(initial.at(-1)).toMatchObject({reason:{kind:'tool-calls'}});expect(first.state.closed).toBe(false);expect(first.state.policy).toContain('Prefer tools exposed by the DeepSeek Harness connector')
   const next=request('unused',[tool]) as {messages:Record<string,unknown>[]};next.messages=[{role:'user',content:[{type:'text',text:'read a.ts'}]},{role:'assistant',content:[{type:'tool-call',id:'call-1',name:'read',arguments:'{"path":"a.ts"}'}]},{role:'user',content:[{type:'tool-result',toolCallId:'call-1',content:[{type:'text',text:'file body'},{type:'image',attachment:imageRef}]}]}]
   const final=await collect(adapter.stream(next as never));expect(opens).toBe(1);expect(first.state.answers).toEqual([{result:[{type:'text',text:'file body'},{type:'image',data:'AQIDBA==',mimeType:'image/png'}],isError:false}]);expect(final.map((x)=>x.type)).toEqual(['block-start','text-delta','block-end','finish']);expect(first.state.closed).toBe(true);await adapter.dispose()
  }finally{await cleanup(file)}
 })
 it('sends admitted DSH images as inline Quick attachments and rejects unreadable images',async()=>{
  const file=path.join(await fs.mkdtemp(path.join(os.tmpdir(),'dsh-aws-quick-images-')),'settings.json')
  try{
   const imageRef={attachmentId:'image-1',mediaType:'image/png',bytes:4,width:1,height:1,name:'pixel.png'};const attachments={readImage:async()=>({ref:imageRef,data:Uint8Array.from([1,2,3,4])}),readImageRequest:async()=>{throw new Error('unexpected scale')}}
   const fake=fakeConnection([[{kind:'text',delta:'seen'},{kind:'done',reason:'stop'}]]);const adapter=new AwsQuickAdapter({settings:new AwsQuickSettingsStore(file),outpost,attachments:attachments as never,openConnection:async()=>fake.connection})
   const models=await adapter.listModels('aws-quick');expect(models[0]?.inputModalities).toEqual(['text','image'])
   const req=request('describe',[ ],'image-session') as {messages:Record<string,unknown>[]};req.messages=[{role:'user',content:[{type:'text',text:'describe'},{type:'image',attachment:imageRef}]}]
   await collect(adapter.stream(req as never));expect(fake.state.attachments).toEqual([{type:'image',name:'pixel.png',size:4,mimeType:'image/png',data:'data:image/png;base64,AQIDBA=='}])
   const missing=new AwsQuickAdapter({settings:new AwsQuickSettingsStore(file),outpost,openConnection:async()=>fake.connection})
   await expect(collect(missing.stream(req as never))).rejects.toThrow(/could not read/);await adapter.dispose();await missing.dispose()
  }finally{await cleanup(file)}
 })
 it('turns a Quick decision card into DSH ask_user_question and answers on the same thread',async()=>{
  const file=path.join(await fs.mkdtemp(path.join(os.tmpdir(),'dsh-aws-quick-decision-')),'settings.json')
  try{
   const ask={name:'ask_user_question',description:'Ask',parameters:{type:'object',properties:{}}}
   const bridge={ensure:async()=>({id:'dsh-quick',fingerprint:'tools',outpostId:'o',resolve:()=>null}),track:()=>{},settle:()=>{},dispose:async()=>{}} as unknown as AwsQuickToolBridge
   const opened:{threadId:string;state:{sent:string}}[]=[]
   const batches=[[{kind:'text',delta:'Lint 已修复。\n<decision question="下一步?">'},{kind:'text',delta:'<option description="触发 CI">推送</option><option>不推送</option></decision>'},{kind:'done',reason:'stop'}],[{kind:'text',delta:'已推送'},{kind:'done',reason:'stop'}]] as QuickStreamEvent[][]
   const adapter=new AwsQuickAdapter({settings:new AwsQuickSettingsStore(file),outpost,toolBridge:bridge,openConnection:async(input)=>{const fake=fakeConnection([batches.shift()!]);opened.push({threadId:input.threadId,state:fake.state});return fake.connection}})
   const first=await collect(adapter.stream(request('修复 lint',[ask]) as never))
   const text=first.filter((c)=>c.type==='text-delta').map((c)=>(c as {text:string}).text).join('');expect(text).toBe('Lint 已修复。\n');expect(text).not.toContain('<decision')
   const call=first.find((c)=>c.type==='tool-call-delta') as unknown as {id:string;name:string;argumentsDelta:string};expect(call.name).toBe('ask_user_question')
   expect(JSON.parse(call.argumentsDelta)).toEqual({questions:[{id:'q1',question:'下一步?',options:[{label:'推送',description:'触发 CI'},{label:'不推送'}]}]});expect(first.at(-1)).toMatchObject({reason:{kind:'tool-calls'}})
   const next=request('unused',[ask]) as {messages:Record<string,unknown>[]};next.messages=[{role:'user',content:[{type:'text',text:'修复 lint'}]},{role:'assistant',content:[{type:'text',text:'Lint 已修复。\n'},{type:'tool-call',id:call.id,name:'ask_user_question',arguments:call.argumentsDelta}]},{role:'user',content:[{type:'tool-result',toolCallId:call.id,content:[{type:'text',text:JSON.stringify({answers:[{id:'q1',selected:['推送']}]})}]}]}]
   await collect(adapter.stream(next as never));expect(opened[1].threadId).toBe(opened[0].threadId);expect(opened[1].state.sent).toBe('<decision_response>下一步?: 推送</decision_response>');await adapter.dispose()
  }finally{await cleanup(file)}
 })
 it('falls back to numbered text when the session offers no question tool',async()=>{
  const file=path.join(await fs.mkdtemp(path.join(os.tmpdir(),'dsh-aws-quick-decision-text-')),'settings.json')
  try{
   const fake=fakeConnection([[{kind:'text',delta:'选一个：<decision question="模式?"><option description="快">A</option><option>B</option></decision>'},{kind:'done',reason:'stop'}]])
   const adapter=new AwsQuickAdapter({settings:new AwsQuickSettingsStore(file),outpost,openConnection:async()=>fake.connection})
   const chunks=await collect(adapter.stream(request('q') as never));const text=chunks.filter((c)=>c.type==='text-delta').map((c)=>(c as {text:string}).text).join('')
   expect(text).toBe('选一个：\n\n**模式?**\n1. A — 快\n2. B');expect(chunks.at(-1)).toMatchObject({reason:{kind:'stop'}});expect(fake.state.policy).toContain('ask_user_question');await adapter.dispose()
  }finally{await cleanup(file)}
 })
 it('carries context DSH appended after a tool round together with the tool result',async()=>{
  const file=path.join(await fs.mkdtemp(path.join(os.tmpdir(),'dsh-aws-quick-extra-')),'settings.json')
  try{
   const tool={name:'enter_plan_mode',description:'Plan',parameters:{type:'object',properties:{}}}
   const fake=fakeConnection([[{kind:'tool-call',call:{id:'call-p',name:'dsh_quick__enter_plan_mode',argumentsText:'{}'}}],[{kind:'text',delta:'ok'},{kind:'done',reason:'stop'}]])
   const bridge={ensure:async()=>({id:'dsh-quick',fingerprint:'tools',outpostId:'o',resolve:(name:string)=>name==='dsh_quick__enter_plan_mode'?'enter_plan_mode':null}),track:()=>{},settle:()=>{},dispose:async()=>{}} as unknown as AwsQuickToolBridge
   const adapter=new AwsQuickAdapter({settings:new AwsQuickSettingsStore(file),outpost,toolBridge:bridge,openConnection:async()=>fake.connection})
   await collect(adapter.stream(request('plan it',[tool]) as never))
   const next=request('unused',[tool]) as {messages:Record<string,unknown>[]};next.messages=[{role:'user',content:[{type:'text',text:'plan it'}]},{role:'assistant',content:[{type:'tool-call',id:'call-p',name:'enter_plan_mode',arguments:'{}'}]},{role:'user',content:[{type:'tool-result',toolCallId:'call-p',content:[{type:'text',text:'entered'}]}]},{role:'user',content:[{type:'text',text:'Plan mode is active: submit with exit_plan_mode.'}]}]
   await collect(adapter.stream(next as never));expect(fake.state.answers).toHaveLength(1);expect(fake.state.answers[0].result).toEqual([{type:'text',text:'entered'},{type:'text',text:'[DSH context added after this tool call]\nPlan mode is active: submit with exit_plan_mode.'}]);await adapter.dispose()
  }finally{await cleanup(file)}
 })
 it('rejects unsupported sampling controls without starting a connection',async()=>{
  const file=path.join(await fs.mkdtemp(path.join(os.tmpdir(),'dsh-aws-quick-sampling-')),'settings.json')
  try{const adapter=new AwsQuickAdapter({settings:new AwsQuickSettingsStore(file),outpost,openConnection:async()=>{throw new Error('must not start')}});const req=request('x');req.temperature=0.2;await expect(collect(adapter.stream(req as never))).rejects.toThrow(/cannot express.*temperature/);await adapter.dispose()}finally{await cleanup(file)}
 })
})
