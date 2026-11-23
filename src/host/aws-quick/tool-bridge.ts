import fs from 'node:fs/promises'
import {existsSync} from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {dshHomeDir} from '../common/home.ts'
import type {GenerateOptions} from '../common/llm-compat.ts'
import type {AwsQuickOutpost} from './outpost.ts'
import type {AwsQuickToolsDto} from '../../shared/aws-quick-contracts.ts'
import {QuickExecutionBroker} from './execution-broker.ts'
import type {QuickResultContent} from './images.ts'
type Tool=NonNullable<GenerateOptions['tools']>[number]
export interface QuickToolCatalog{id:string;fingerprint:string;outpostId:string;resolve(name:string):string|null}
interface QuickMcpEntry{id?:string;name?:string;enabled?:boolean;transport?:string;command?:string;args?:unknown[];env?:Record<string,string>;tools?:unknown[];status?:string;error?:string}
function fingerprint(tools:Tool[]):string{return createHash('sha256').update(JSON.stringify(tools.map((tool)=>[tool.name,tool.description,tool.parameters]))).digest('hex').slice(0,16)}
function control(result:unknown,action:string):void{if(typeof result==='object'&&result&&(result as {success?:boolean}).success===false)throw new Error('Quick MCP '+action+' failed: '+String((result as {error?:unknown}).error??'unknown error'))}
/** Inputs for {@link resolveQuickNode}; all optional so tests can drive it without touching process globals. */
export interface QuickNodeResolveOptions{platform?:NodeJS.Platform;execPath?:string;resourcesPath?:string;isElectron?:boolean;exists?(candidate:string):boolean;pathEnv?:string}
/**
 * The Node executable Quick should spawn for the stdio MCP entry.
 *
 * Quick launches the registered `command` directly and parses its stdout as
 * JSON-RPC. In the Desktop build `process.execPath` is the Electron app
 * (`DeepSeek Harness.exe`); launching it prints the desktop shell's own startup
 * output onto that pipe and the MCP handshake dies with `Invalid JSON: EOF while
 * parsing a value` (issue #126). Under a plain Node host `process.execPath` is
 * already node, so it is returned unchanged; under Electron the DSH-installed
 * `runtime/primary-runtime/dependencies/node` binary, then a PATH node, is
 * preferred. When none is found a clear error is raised rather than silently
 * resurrecting the broken Electron launcher.
 */
export function resolveQuickNode(opts:QuickNodeResolveOptions={}):string{
 const platform=opts.platform??process.platform
 const execPath=opts.execPath??process.execPath
 const isElectron=opts.isElectron??Boolean(process.versions.electron)
 if(!isElectron)return execPath
 const exists=opts.exists??((candidate:string)=>existsSync(candidate))
 const bin=platform==='win32'?'node.exe':'node'
 const roots=new Set<string>()
 const resourcesPath=opts.resourcesPath??(process as {resourcesPath?:string}).resourcesPath
 if(resourcesPath)roots.add(resourcesPath)
 roots.add(path.join(path.dirname(execPath),'resources'))
 for(const root of roots){const candidate=path.join(root,'runtime','primary-runtime','dependencies','node','bin',bin);if(exists(candidate))return candidate}
 const pathEnv=opts.pathEnv??process.env.PATH??process.env.Path??''
 for(const dir of pathEnv.split(path.delimiter)){if(!dir)continue;const candidate=path.join(dir,bin);if(exists(candidate))return candidate}
 throw new Error('AWS Quick could not find a Node executable to run the DeepSeek Harness MCP bridge. Run DeepSeek Harness from its desktop installer (which bundles Node), or put a node executable on PATH.')
}
export class AwsQuickToolBridge{
 private readonly catalogs=new Map<string,QuickToolCatalog>()
 private readonly union=new Map<string,Tool>()
 private lifecycle:Promise<void>=Promise.resolve()
 private publishedState=false
 private readonly statePath:string
 private readonly entryFile:string|undefined
 private tools:AwsQuickToolsDto={state:'not_initialized'}
 private readonly broker=new QuickExecutionBroker()
 constructor(private readonly outpost:AwsQuickOutpost,options:{statePath?:string;entryFile?:string}={}){this.statePath=options.statePath??path.join(dshHomeDir(),'storages','aws-quick-tools.json');this.entryFile=options.entryFile}
 private entryPath():string{if(this.entryFile)return this.entryFile;const moduleDir=path.dirname(fileURLToPath(import.meta.url));const bundled=path.join(moduleDir,'aws-quick-mcp.js');return existsSync(bundled)?bundled:path.resolve(moduleDir,'../../../lib/aws-quick-mcp.js')}
 private async writeState(includeExecution=true):Promise<void>{
  await fs.mkdir(path.dirname(this.statePath),{recursive:true})
  const temp=this.statePath+'.tmp.'+process.pid+'.'+Date.now()
  const tools=[...this.union.values()].map((tool)=>({name:tool.name,description:tool.description,parameters:tool.parameters??{type:'object',properties:{}}}))
  const execution=includeExecution?await this.broker.start():undefined
  await fs.writeFile(temp,JSON.stringify({version:1,tools,...(execution?{execution}:{})},null,2),{encoding:'utf8',mode:0o600});await fs.rename(temp,this.statePath)
 }
 // Quick has one connector and one state file shared by all host sessions.
 private inOrder<T>(operation:()=>Promise<T>):Promise<T>{
  const result=this.lifecycle.then(operation)
  this.lifecycle=result.then(()=>undefined,()=>undefined)
  return result
 }
 status():AwsQuickToolsDto{return{...this.tools}}
 private async restoreTools():Promise<void>{
  try{
   const state=JSON.parse(await fs.readFile(this.statePath,'utf8')) as {tools?:unknown}
   if(!Array.isArray(state?.tools))return
   for(const candidate of state.tools){
    if(!candidate||typeof candidate!=='object')continue
    const tool=candidate as Partial<Tool>
    if(typeof tool.name==='string'&&tool.name&&typeof tool.description==='string'&&!this.union.has(tool.name))this.union.set(tool.name,tool as Tool)
   }
  }catch(error){
   if(!(error instanceof SyntaxError)&&(error as NodeJS.ErrnoException).code!=='ENOENT')throw error
  }
 }
 track(call:{id:string;name:string;argumentsText:string}):void{this.broker.track(call)}
 settle(id:string,content:QuickResultContent[],isError=false):void{this.broker.settle(id,content,isError)}
 prepare():Promise<AwsQuickToolsDto>{
  return this.inOrder(async()=>{await this.register(false);return this.status()})
 }
 private async register(requireTools:boolean):Promise<void>{
  this.tools={state:'pending'}
  try{
   if(!this.publishedState)await this.restoreTools()
   await this.writeState()
   this.publishedState=true
   const id='dsh-quick'
   let listed=await this.outpost.mcp<{servers?:QuickMcpEntry[]}>('list')
   let registered=listed.servers?.find((entry)=>entry.id===id)
   const config={id,name:'DeepSeek Harness',description:'DSH tools exposed by DeepSeek Harness',transport:'stdio',command:resolveQuickNode(),args:[this.entryPath(),this.statePath],env:{...registered?.env,ELECTRON_RUN_AS_NODE:'1'},enabled:true}
   const sameLauncher=registered?.transport==='stdio'&&registered.name===config.name&&registered.command===config.command&&JSON.stringify(registered.args??[])===JSON.stringify(config.args)
   if(registered?.enabled===false){
    if(sameLauncher){this.tools={state:'approval_required'};return}
    control(await this.outpost.mcp('remove',{id}),'remove');registered=undefined
   }
   if(!registered)control(await this.outpost.mcp('add',config),'add')
   else if(!sameLauncher||registered.env?.ELECTRON_RUN_AS_NODE!=='1')control(await this.outpost.mcp('update',config),'update')
   listed=await this.outpost.mcp<{servers?:QuickMcpEntry[]}>('list');registered=listed.servers?.find((entry)=>entry.id===config.id)
   if(!registered||registered.enabled===false){this.tools={state:'approval_required'};return}
   const deadline=Date.now()+45_000;let reloaded=false
   while(true){
    if(registered?.enabled===false){this.tools={state:'approval_required'};return}
    const published=registered?.tools?.map((tool)=>typeof tool==='object'&&tool&&typeof (tool as {name?:unknown}).name==='string'?(tool as {name:string}).name:'')??[]
    const covered=[...this.union.keys()].every((name)=>published.some((candidate)=>candidate===name||candidate.endsWith('__'+name)))
    const ready=registered&&(registered.status===undefined||registered.status==='connected')&&(!requireTools||covered)
    if(ready&&(!requireTools||reloaded)){this.tools={state:'ready'};return}
    if(registered?.error)throw new Error('DeepSeek Harness MCP startup failed: '+registered.error)
    if(!reloaded&&registered&&registered.status!=='starting'){control(await this.outpost.mcp('reload',{id:config.id}),'reload');reloaded=true}
    if(Date.now()>=deadline)throw new Error('DeepSeek Harness MCP did not become ready within 45 seconds.')
    await new Promise((resolve)=>setTimeout(resolve,250))
    listed=await this.outpost.mcp<{servers?:QuickMcpEntry[]}>('list');registered=listed.servers?.find((entry)=>entry.id===config.id)
   }
  }catch(error){this.tools={state:'error',detail:error instanceof Error?error.message:String(error)};throw error}
 }
 ensure(tools:Tool[]):Promise<QuickToolCatalog>{return this.inOrder(()=>this.ensureCatalog(tools))}
 private async ensureCatalog(tools:Tool[]):Promise<QuickToolCatalog>{
  if(tools.length===0)throw new Error('Cannot register an empty Quick tool catalog.')
  const digest=fingerprint(tools);const existing=this.catalogs.get(digest);if(existing)return existing
  for(const tool of tools)this.union.set(tool.name,tool)
  await this.register(true)
  if(this.tools.state==='approval_required')throw new Error('DeepSeek Harness tools need one-time native approval. Open Quick → Customize → Connectors, enable DeepSeek Harness, then retry. This plugin does not bypass Quick confirmation.')
  const outpostId=await this.outpost.outpostId();const catalog:QuickToolCatalog={id:'dsh-quick',fingerprint:digest,outpostId,resolve:(name)=>{
   if(tools.some((tool)=>tool.name===name))return name
   for(const prefix of ['mcp__dsh-quick__','mcp__dsh_quick__','dsh-quick__','dsh_quick__']){if(name.startsWith(prefix)){const original=name.slice(prefix.length);return tools.some((tool)=>tool.name===original)?original:null}}
   return null
  }}
  this.catalogs.set(digest,catalog);return catalog
 }

 dispose():Promise<void>{
  return this.inOrder(async()=>{
   await this.broker.close()
   if(this.publishedState)await this.writeState(false).catch(()=>undefined)
   this.publishedState=false
   this.catalogs.clear();this.union.clear();this.tools={state:'not_initialized'}
  })
 }
}