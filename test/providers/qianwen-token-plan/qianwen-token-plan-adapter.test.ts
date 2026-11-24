import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions as HarnessGenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { CredentialStore } from '../../../src/host/infra/storage/token-store.ts'
import { QianwenTokenPlanAdapter } from '../../../src/host/providers/qianwen-token-plan/adapter.ts'
import { registerQianwenTokenPlanRoutes } from '../../../src/host/providers/qianwen-token-plan/routes.ts'
import { QianwenCredentialStore, QianwenSettingsStore, type QianwenCredentials } from '../../../src/host/providers/qianwen-token-plan/token-store.ts'
import { PROVIDER_ID } from '../../../src/host/providers/qianwen-token-plan/types.ts'

const dirs:string[]=[]
afterEach(async()=>{
  for(const dir of dirs.splice(0)){
    for(const name of await fs.readdir(dir).catch(()=>[] as string[])) await fs.unlink(path.join(dir,name)).catch(()=>undefined)
    await fs.rmdir(dir).catch(()=>undefined)
  }
})
class MemoryBackend implements CredentialStore<QianwenCredentials>{
  value:QianwenCredentials|null=null
  async load(){return this.value}
  async save(value:QianwenCredentials){this.value=value}
  async clear(){this.value=null}
}
async function stores(){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'qwen-adapter-'));dirs.push(dir)
  const backend=new MemoryBackend()
  const credentials=new QianwenCredentialStore('/tmp/qwen-adapter',backend)
  const settings=new QianwenSettingsStore(path.join(dir,'settings.json'))
  return {backend,credentials,settings}
}
const requestOptions=(overrides:Record<string,unknown>={})=>({
  provider:PROVIDER_ID,model:'qwen4-max',messages:[{role:'user',content:[{type:'text',text:'hello'}]}],...overrides,
}) as HarnessGenerateOptions
const SSE=[
  'data: '+JSON.stringify({choices:[{delta:{reasoning_content:'summary'},finish_reason:null}]}),
  'data: '+JSON.stringify({choices:[{delta:{encrypted_content:'cipher'},finish_reason:null}]}),
  'data: '+JSON.stringify({choices:[{delta:{content:'answer'},finish_reason:null}]}),
  'data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:2048,completion_tokens:20,prompt_tokens_details:{cached_tokens:1024,cache_write_tokens:1024,cache_creation:{ephemeral_5m_input_tokens:0,ephemeral_1h_input_tokens:1024}},completion_tokens_details:{reasoning_tokens:10}}}),
  'data: [DONE]','',
].join('\n\n')

describe('Qwen adapter real stream path',()=>{
  it('builds the configured request and emits encrypted replay plus disjoint usage',async()=>{
    const {backend,credentials,settings}=await stores()
    await credentials.write({apiKey:'sk-sp-secret',authenticatedAt:1})
    await settings.updateSettings({cacheTtl:'1h',defaultReasoningEffort:'high'})
    let body:Record<string,unknown>|undefined
    let authorization:unknown
    const fetchFn=vi.fn(async(_input:RequestInfo|URL,init?:RequestInit)=>{
      body=JSON.parse(String(init?.body));authorization=new Headers(init?.headers).get('authorization')
      return new Response(SSE,{status:200,headers:{'content-type':'text/event-stream'}})
    }) as typeof fetch
    const adapter=new QianwenTokenPlanAdapter(credentials,settings,{fetchFn})
    expect((await adapter.listModels()).map(model=>model.id)).toContain('qwen4-max')
    const chunks:StreamChunk[]=[]
    for await(const chunk of adapter.stream(requestOptions({sessionId:'qwen-session',reasoningEffort:'max',maxTokens:8192}))) chunks.push(chunk)
    expect(authorization).toBe('Bearer sk-sp-secret')
    expect(body).toMatchObject({model:'qwen4-max',reasoning_effort:'max',max_completion_tokens:8192,prompt_cache_options:{mode:'implicit',ttl:'1h'},thinking_display:'summarized',preserve_thinking:true})
    expect(body).not.toHaveProperty('thinking_budget')
    const finish=chunks.find(chunk=>chunk.type==='finish')
    expect(JSON.stringify(finish)).toContain('cipher')
    const usage=chunks.find(chunk=>chunk.type==='usage')
    expect(usage).toMatchObject({type:'usage',usage:{inputTokens:0,cacheReadTokens:1024,cacheWriteTokens:1024,outputTokens:20,reasoningTokens:10}})
    expect(chunks.map(chunk=>chunk.type).lastIndexOf('usage')).toBeLessThan(chunks.map(chunk=>chunk.type).lastIndexOf('finish'))
  })
  it('keeps an explicitly empty model selection and rejects missing credentials',async()=>{
    const {credentials,settings}=await stores()
    const adapter=new QianwenTokenPlanAdapter(credentials,settings,{fetchFn:vi.fn() as never})
    expect(await adapter.listModels()).toEqual([])
    await expect(async()=>{for await(const _ of adapter.stream(requestOptions())) void _}).rejects.toMatchObject({code:'MISSING_CREDENTIAL'})
    await settings.updateSettings({enabledModelIds:[]})
    expect(await adapter.listModels()).toEqual([])
  })
  it('treats a stream without a terminal event as truncated transport',async()=>{
    const {credentials,settings}=await stores()
    await credentials.write({apiKey:'sk-sp-secret',authenticatedAt:1})
    const fetchFn=async()=>new Response('data: '+JSON.stringify({choices:[{delta:{content:'partial'},finish_reason:null}]})+'\n\n',{status:200})
    const adapter=new QianwenTokenPlanAdapter(credentials,settings,{fetchFn:fetchFn as typeof fetch})
    await expect(async()=>{for await(const _ of adapter.stream(requestOptions())) void _}).rejects.toMatchObject({code:'TRANSPORT'})
  })
})

describe('Qwen routes same-origin mutations',()=>{
  it('rejects a cross-site key write before touching credentials, then accepts loopback same origin',async()=>{
    const {backend,credentials,settings}=await stores()
    let handler:((req:unknown,res:unknown)=>Promise<void>)|undefined
    const ctx={webServer:{register(def:{handler:(req:unknown,res:unknown)=>Promise<void>}){handler=def.handler;return()=>undefined}},emit:vi.fn()}
    registerQianwenTokenPlanRoutes(ctx as never,credentials,settings)
    const invoke=async(origin:string)=>{
      const req=Object.assign(new EventEmitter(),{method:'PUT',url:'/qianwen-token-plan/api/credentials',headers:{host:'127.0.0.1:3080',origin},destroy:vi.fn()})
      let status=0;let responseBody=''
      const res={writeHead(code:number){status=code},end(body:string){responseBody=body}}
      const promise=handler!(req,res)
      req.emit('data',Buffer.from(JSON.stringify({apiKey:'sk-sp-secret'})));req.emit('end')
      await promise
      return {status,body:JSON.parse(responseBody)}
    }
    expect((await invoke('https://attacker.example')).status).toBe(403)
    expect(backend.value).toBeNull()
    expect((await invoke('http://127.0.0.1:3080')).status).toBe(200)
    expect(backend.value?.apiKey).toBe('sk-sp-secret')
  })
})
