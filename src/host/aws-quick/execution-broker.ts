import http from 'node:http'
import type {AddressInfo} from 'node:net'
import type {IncomingMessage,ServerResponse} from 'node:http'
import {randomBytes} from 'node:crypto'
import type {QuickResultContent} from './images.ts'

interface Call{id:string;name:string;argumentsText:string}
interface Pending{call:Call;key:string;answer?:Answer}
type Answer=(result:{content:QuickResultContent[];isError?:boolean})=>void
interface Waiting{key:string;answer:Answer;timer:ReturnType<typeof setTimeout>}
function stable(value:unknown):string{
 if(Array.isArray(value))return '['+value.map(stable).join(',')+']'
 if(value&&typeof value==='object')return '{'+Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+stable(item)).join(',')+'}'
 return JSON.stringify(value)
}
function key(name:string,args:unknown):string{return name+'\0'+stable(args)}
function dshName(name:string):string{for(const prefix of ['mcp__dsh-quick__','mcp__dsh_quick__','dsh-quick__','dsh_quick__'])if(name.startsWith(prefix))return name.slice(prefix.length);return name}
function failure(text:string){return{content:[{type:'text' as const,text}],isError:true}}
export class QuickExecutionBroker{
 private server:http.Server|undefined;private endpoint:string|undefined;private readonly token=randomBytes(32).toString('base64url')
 private readonly pending=new Map<string,Pending>();private readonly waiting=new Set<Waiting>()
 async start():Promise<{url:string;token:string}>{
  if(this.endpoint)return{url:this.endpoint,token:this.token}
  const server=http.createServer((request,response)=>{void this.handle(request,response)});this.server=server
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve()})})
  this.endpoint='http://127.0.0.1:'+(server.address() as AddressInfo).port+'/call';return{url:this.endpoint,token:this.token}
 }
 get matchedCount():number{return[...this.pending.values()].filter((item)=>item.answer!==undefined).length}
 track(call:Call):void{
  const item:Pending={call,key:key(call.name,parse(call.argumentsText))};this.pending.set(call.id,item)
  for(const waiter of [...this.waiting])if(waiter.key===item.key){clearTimeout(waiter.timer);this.waiting.delete(waiter);item.answer=waiter.answer;break}
 }
 settle(id:string,content:QuickResultContent[],isError=false):void{const item=this.pending.get(id);if(!item)return;this.pending.delete(id);item.answer?.({content,...(isError?{isError:true}:{})})}
 async close():Promise<void>{
  for(const item of this.pending.values())item.answer?.(failure('The Quick DSH turn closed before the tool result arrived.'))
  this.pending.clear();for(const waiter of this.waiting){clearTimeout(waiter.timer);waiter.answer(failure('The Quick DSH bridge closed before the tool call arrived.'))}this.waiting.clear()
  const server=this.server;this.server=undefined;this.endpoint=undefined;if(server){const closed=new Promise<void>((resolve)=>server.close(()=>resolve()));server.closeAllConnections();await closed}
 }
 private authorized(request:IncomingMessage):boolean{
  if(request.headers.authorization!=='Bearer '+this.token)return false
  const host=request.headers.host;if(typeof host!=='string')return false
  try{const hostname=new URL('http://'+host).hostname.toLowerCase();if(!['127.0.0.1','localhost','::1','[::1]'].includes(hostname))return false}catch{return false}
  const origin=request.headers.origin;if(typeof origin==='string'&&origin){try{const hostname=new URL(origin).hostname.toLowerCase();if(!['127.0.0.1','localhost','::1','[::1]'].includes(hostname))return false}catch{return false}}
  return true
 }
 private async handle(request:IncomingMessage,response:http.ServerResponse):Promise<void>{
  const send=(status:number,value:unknown)=>{if(response.headersSent)return;response.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});response.end(JSON.stringify(value))}
  if(request.method!=='POST'||request.url!=='/call')return send(404,failure('Not found.'))
  if(!this.authorized(request))return send(403,failure('Forbidden.'))
  try{
   const chunks:Buffer[]=[];let size=0;for await(const chunk of request){const data=Buffer.from(chunk);size+=data.length;if(size>1_048_576)return send(413,failure('Tool arguments are too large.'));chunks.push(data)}
   const body=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}') as {name?:unknown;arguments?:unknown}
   if(typeof body.name!=='string'||!body.name)return send(400,failure('Missing tool name.'))
   const name=dshName(body.name);const callKey=key(name,body.arguments??{})
   // Identical concurrent calls share a key; claim each WSS call at most once.
   const matched=[...this.pending.values()].find((item)=>item.key===callKey&&item.answer===undefined)
   const result=new Promise<{content:QuickResultContent[];isError?:boolean}>((resolve)=>{
    if(matched){matched.answer=resolve;return}
    const waiter:Waiting={key:callKey,answer:resolve,timer:setTimeout(()=>{this.waiting.delete(waiter);resolve(failure('No active Quick WSS tool call matched this MCP request.'))},10_000)}
    this.waiting.add(waiter)
   })
   // Acknowledge the match (or FIFO waiter) before its tool result is available.
   response.writeHead(200,{'Content-Type':'application/json; charset=utf-8'})
   response.flushHeaders()
   response.end(JSON.stringify(await result))
  }catch{return send(400,failure('Invalid tool call body.'))}
 }
}
function parse(text:string):unknown{try{return JSON.parse(text)}catch{return text}}
export {}
