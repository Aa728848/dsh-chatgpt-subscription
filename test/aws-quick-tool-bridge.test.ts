import fs from 'node:fs/promises'
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
   expect(add).toMatchObject({name:'DeepSeek Harness',transport:'stdio',command:process.execPath});expect(add.url).toBeUndefined()
   const client=new Client({name:'test-client',version:'1.0.0'})
   const transport=new StdioClientTransport({command:process.execPath,args:['--experimental-transform-types',entryFile,statePath],stderr:'pipe'})
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
})
