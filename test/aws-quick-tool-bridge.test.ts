import fs from 'node:fs/promises'
import type {RequestListener,Server} from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {describe,expect,it,vi} from 'vitest'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js'
import {AwsQuickToolBridge} from '../src/host/aws-quick/tool-bridge.ts'
import type {AwsQuickOutpost} from '../src/host/aws-quick/outpost.ts'
describe('AWS Quick stdio tool bridge',()=>{
 it('publishes DSH schemas through a real stdio MCP client and uses a stable named connector',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-quick-stdio-'));const statePath=path.join(dir,'tools.json');const entryFile=path.join(process.cwd(),'src/entry-aws-quick-mcp.ts')
  const calls:{action:string;body:Record<string,unknown>}[]=[]
  let registered=false
  const outpost={
   mcp:async(action:string,body:Record<string,unknown>)=>{
    calls.push({action,body});if(action==='add')registered=true;if(action==='remove')registered=false
    if(action==='list')return{servers:registered?[{id:'dsh-quick',name:'DeepSeek Harness',enabled:true,transport:'stdio',command:process.execPath,args:[entryFile,statePath],tools:[{name:'read'}]}]:[]}
    if(action==='add')return{success:true,server:{id:'dsh-quick'}}
    return{success:true}
   },
   outpostId:async()=> 'official-outpost',
  } as unknown as AwsQuickOutpost
  const bridge=new AwsQuickToolBridge(outpost,{statePath,entryFile})
  try{
   const catalog=await bridge.ensure([{name:'read',description:'Read file',parameters:{type:'object',properties:{path:{type:'string'}}}}])
   const add=calls.find((call)=>call.action==='add')!.body as {name:string;transport:string;command:string;args:string[];url?:string}
   expect(add).toMatchObject({name:'DeepSeek Harness',transport:'stdio',command:process.execPath,env:{ELECTRON_RUN_AS_NODE:'1'}});expect(add.url).toBeUndefined()
   const client=new Client({name:'test-client',version:'1.0.0'})
   const transport=new StdioClientTransport({command:process.execPath,args:[entryFile,statePath],stderr:'pipe'})
   await client.connect(transport)
   const listed=await client.listTools()
   expect(listed.tools).toEqual([{name:'read',description:'Read file',inputSchema:{type:'object',properties:{path:{type:'string'}}}}])
   bridge.track({id:'call-1',name:'read',argumentsText:'{"path":"a.ts"}'})
   const pending=client.callTool({name:'dsh_quick__read',arguments:{path:'a.ts'}})
   await vi.waitFor(()=>{expect((bridge as never as {broker:{matchedCount:number}}).broker.matchedCount).toBe(1)},{timeout:5000,interval:10});bridge.settle('call-1',[{type:'text',text:'file body'}])
   await expect(pending).resolves.toMatchObject({content:[{type:'text',text:'file body'}]})
   await client.close()
  }finally{await bridge.dispose();expect(calls.some((call)=>call.action==='remove')).toBe(false);const persisted=JSON.parse(await fs.readFile(statePath,'utf8'));expect(persisted.tools).toEqual([{name:'read',description:'Read file',parameters:{type:'object',properties:{path:{type:'string'}}}}]);expect(persisted.execution).toBeUndefined();await fs.unlink(statePath).catch(()=>undefined);await fs.rmdir(dir).catch(()=>undefined)}
 })
 it('forces Electron Node mode and upgrades an existing connector that lacks it',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-quick-node-mode-'));const statePath=path.join(dir,'tools.json');const entryFile=path.join(process.cwd(),'src/entry-aws-quick-mcp.ts')
  const updates:Record<string,unknown>[]=[];let env:Record<string,string>={QUICK_PROFILE:'work'}
  const outpost={mcp:async(action:string,body:Record<string,unknown>)=>{
   if(action==='update'){updates.push(body);env=body.env as Record<string,string>}
   if(action==='list')return{servers:[{id:'dsh-quick',name:'DeepSeek Harness',enabled:true,status:'connected',transport:'stdio',command:process.execPath,args:[entryFile,statePath],...(env?{env}:{}),tools:[]}]}
   return{success:true}
  }} as unknown as AwsQuickOutpost
  const bridge=new AwsQuickToolBridge(outpost,{statePath,entryFile})
  try{
   await expect(Promise.all([bridge.prepare(),bridge.prepare()])).resolves.toEqual([{state:'ready'},{state:'ready'}])
   expect(env).toEqual({QUICK_PROFILE:'work',ELECTRON_RUN_AS_NODE:'1'})
   expect(updates).toHaveLength(1)
  }finally{await bridge.dispose();await fs.unlink(statePath).catch(()=>undefined);await fs.rmdir(dir).catch(()=>undefined)}
 })
 it('restores persisted tool schemas when preparing after a host restart',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-quick-restore-'));const statePath=path.join(dir,'tools.json');const entryFile=path.join(process.cwd(),'src/entry-aws-quick-mcp.ts')
  const tool={name:'read',description:'Read file',parameters:{type:'object',properties:{path:{type:'string'}}}}
  await fs.writeFile(statePath,JSON.stringify({version:1,tools:[tool]}))
  const outpost={mcp:async(action:string)=>action==='list'?{servers:[{id:'dsh-quick',name:'DeepSeek Harness',enabled:true,status:'connected',transport:'stdio',command:process.execPath,args:[entryFile,statePath],env:{ELECTRON_RUN_AS_NODE:'1'},tools:[{name:'read'}]}]}:{success:true}} as unknown as AwsQuickOutpost
  const bridge=new AwsQuickToolBridge(outpost,{statePath,entryFile})
  try{await expect(bridge.prepare()).resolves.toEqual({state:'ready'});expect(JSON.parse(await fs.readFile(statePath,'utf8')).tools).toEqual([tool])}finally{await bridge.dispose();await fs.unlink(statePath).catch(()=>undefined);await fs.rmdir(dir).catch(()=>undefined)}
 })
 it('merges saved schemas on the first chat and prefers the live tool definition',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-quick-first-chat-'))
  const statePath=path.join(dir,'tools.json')
  const saved={name:'read',description:'Read',parameters:{type:'object' as const}}
  const live={name:'write',description:'Current schema',parameters:{type:'object' as const}}
  await fs.writeFile(statePath,JSON.stringify({version:1,tools:[saved,{...live,description:'Old schema'}]}))
  const outpost={
   mcp:async(action:string)=>action==='list'?{servers:[{id:'dsh-quick',enabled:true,tools:[saved,live]}]}:{success:true},
   outpostId:async()=>'outpost',
  } as unknown as AwsQuickOutpost
  const bridge=new AwsQuickToolBridge(outpost,{statePath})
  try{
   const catalog=await bridge.ensure([live])
   const {tools}=JSON.parse(await fs.readFile(statePath,'utf8'))
   expect(tools).toHaveLength(2)
   expect(tools).toEqual(expect.arrayContaining([saved,live]))
   expect(catalog.resolve(saved.name)).toBeNull()
  }finally{await bridge.dispose();await fs.unlink(statePath);await fs.rmdir(dir)}
 })
 it('keeps saved tools when an unused bridge is disposed',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-quick-idle-'))
  const statePath=path.join(dir,'tools.json')
  const state={version:1,tools:[{name:'read',description:'Read',parameters:{type:'object'}}]}
  await fs.writeFile(statePath,JSON.stringify(state))
  try{
   const bridge=new AwsQuickToolBridge({} as AwsQuickOutpost,{statePath})
   await bridge.dispose()
   expect(JSON.parse(await fs.readFile(statePath,'utf8'))).toEqual(state)
  }finally{await fs.unlink(statePath);await fs.rmdir(dir)}
 })
 it('keeps a disabled legacy connector pending native approval during migration',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-quick-approval-'))
  const statePath=path.join(dir,'tools.json');const entryFile=path.join(dir,'entry.js')
  const actions:string[]=[]
  const outpost={mcp:async(action:string)=>{
   actions.push(action)
   return action==='list'?{servers:[{id:'dsh-quick',name:'DeepSeek Harness',transport:'stdio',command:process.execPath,args:[entryFile,statePath],enabled:false}]}:{success:true}
  }} as unknown as AwsQuickOutpost
  const bridge=new AwsQuickToolBridge(outpost,{statePath,entryFile})
  try{
   await expect(bridge.prepare()).resolves.toEqual({state:'approval_required'})
   expect(actions.filter(action=>action!=='list')).toEqual([])
  }finally{await bridge.dispose();await fs.unlink(statePath);await fs.rmdir(dir)}
 })
 it('prepares a connector before any tool request and reports native approval without bypassing it',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-quick-prepare-'));const statePath=path.join(dir,'tools.json');const entryFile=path.join(process.cwd(),'src/entry-aws-quick-mcp.ts');let added=false
  const outpost={mcp:async(action:string)=>{if(action==='add'){added=true;return{success:true}}if(action==='list')return{servers:added?[{id:'dsh-quick',name:'DeepSeek Harness',enabled:false,transport:'stdio',command:process.execPath,args:[entryFile,statePath]}]:[]};return{success:true}}} as unknown as AwsQuickOutpost
  const bridge=new AwsQuickToolBridge(outpost,{statePath,entryFile})
  try{await expect(bridge.prepare()).resolves.toEqual({state:'approval_required'});expect(added).toBe(true);expect(JSON.parse(await fs.readFile(statePath,'utf8'))).toMatchObject({version:1,tools:[],execution:{url:expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/call$/),token:expect.any(String)}})}finally{await bridge.dispose();await fs.unlink(statePath).catch(()=>undefined);await fs.rmdir(dir).catch(()=>undefined)}
 })
 it('marks an already approved connector ready even before it exposes tools',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-quick-ready-'));const statePath=path.join(dir,'tools.json');const entryFile=path.join(process.cwd(),'src/entry-aws-quick-mcp.ts')
  let published=false;const outpost={mcp:async(action:string)=>{if(action==='reload')published=true;return action==='list'?{servers:[{id:'dsh-quick',name:'DeepSeek Harness',enabled:true,status:'connected',transport:'stdio',command:process.execPath,args:[entryFile,statePath],tools:published?[{name:'dsh_quick__read'}]:[]}]}:{success:true}},outpostId:async()=> 'outpost'} as unknown as AwsQuickOutpost
  const bridge=new AwsQuickToolBridge(outpost,{statePath,entryFile})
  try{await expect(bridge.prepare()).resolves.toEqual({state:'ready'});expect(bridge.status()).toEqual({state:'ready'});const catalog=await bridge.ensure([{name:'read',description:'Read',parameters:{type:'object'}}]);expect(published).toBe(true);expect(catalog.resolve('dsh_quick__read')).toBe('read')}finally{await bridge.dispose();await fs.unlink(statePath).catch(()=>undefined);await fs.rmdir(dir).catch(()=>undefined)}
 })
 it('maps Quick MCP-qualified tool names back to the DSH name',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-quick-names-'));const statePath=path.join(dir,'tools.json')
  const outpost={mcp:async(action:string)=>action==='list'?{servers:[{id:'dsh-quick',name:'DeepSeek Harness',enabled:true,tools:[{name:'read'}]}]}:{success:true},outpostId:async()=> 'outpost'} as unknown as AwsQuickOutpost
  const bridge=new AwsQuickToolBridge(outpost,{statePath,entryFile:path.join(process.cwd(),'src/entry-aws-quick-mcp.ts')})
  try{const catalog=await bridge.ensure([{name:'read',description:'Read',parameters:{type:'object'}}]);expect(catalog.resolve('mcp__dsh_quick__read')).toBe('read');expect(catalog.resolve('other')).toBeNull()}finally{await bridge.dispose();await fs.unlink(statePath).catch(()=>undefined);await fs.rmdir(dir).catch(()=>undefined)}
 })
 it('keeps identical concurrent MCP requests attached to distinct Quick WSS calls',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-quick-concurrent-'));const statePath=path.join(dir,'tools.json');const entryFile=path.join(process.cwd(),'src/entry-aws-quick-mcp.ts')
  const outpost={mcp:async(action:string)=>action==='list'?{servers:[{id:'dsh-quick',name:'DeepSeek Harness',enabled:true,transport:'stdio',command:process.execPath,args:[entryFile,statePath],tools:[{name:'dsh_quick__read'}]}]}:{success:true},outpostId:async()=> 'outpost'} as unknown as AwsQuickOutpost
  const bridge=new AwsQuickToolBridge(outpost,{statePath,entryFile});const client=new Client({name:'test-client',version:'1.0.0'})
  try{
   await bridge.ensure([{name:'read',description:'Read',parameters:{type:'object'}}])
   await client.connect(new StdioClientTransport({command:process.execPath,args:[entryFile,statePath],stderr:'pipe'}))
   // Delay the first HTTP handler to exercise receipt order across independent connections.
   const broker=(bridge as unknown as {broker:{server:Server;matchedCount:number}}).broker
   const [handle]=broker.server.listeners('request') as RequestListener[]
   broker.server.removeListener('request',handle)
   let firstRequest=true
   broker.server.on('request',(request,response)=>{
    if(firstRequest){firstRequest=false;setTimeout(()=>handle(request,response),100)}
    else handle(request,response)
   })
   bridge.track({id:'call-1',name:'read',argumentsText:'{"path":"same.ts"}'});bridge.track({id:'call-2',name:'read',argumentsText:'{"path":"same.ts"}'})
   const first=client.callTool({name:'dsh_quick__read',arguments:{path:'same.ts'}});const second=client.callTool({name:'dsh_quick__read',arguments:{path:'same.ts'}})
   await vi.waitFor(()=>{expect(broker.matchedCount).toBe(2)},{timeout:5000,interval:10})
   bridge.settle('call-1',[{type:'text',text:'first'}]);bridge.settle('call-2',[{type:'text',text:'second'}])
   await expect(first).resolves.toMatchObject({content:[{type:'text',text:'first'}]});await expect(second).resolves.toMatchObject({content:[{type:'text',text:'second'}]})
  }finally{await client.close();await bridge.dispose();await fs.unlink(statePath).catch(()=>undefined);await fs.rmdir(dir).catch(()=>undefined)}
 })
})
