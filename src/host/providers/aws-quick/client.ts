import {randomUUID} from 'node:crypto'
import {LlmError} from '../../common/llm-compat.ts'
import {WebSocket} from 'undici'
import type {QuickSession,AwsQuickOutpost} from './outpost.ts'
import {decodeQuickOutput,encodeQuickInput,isQuickChatHost,QUICK_CHAT_WS_PATH,quickSessionConnect,quickStopGeneration,quickUserMessage,unwrapQuickToolArguments,quickApprovalDecision,quickPermissionReply,readQuickPermissionRequest,type QuickWireEvent} from './protocol.ts'
import type {AwsQuickEffort,AwsQuickMode} from '../../../shared/aws-quick-contracts.ts'
import type {QuickImageAttachment,QuickResultContent} from './images.ts'

export type QuickRawObserver=(event:QuickWireEvent)=>void
/** Decides whether a Quick-side approval request concerns a tool DSH owns (and will permission itself). */
export type QuickApprovalResolver=(request:{toolName?:string;actionId?:string;connectorId?:string})=>boolean
export interface QuickToolCall{id:string;name:string;argumentsText:string}
export type QuickStreamEvent={kind:'text'|'reasoning';delta:string}|{kind:'tool-call';call:QuickToolCall}|{kind:'done';reason:'stop'|'cancelled';text?:string}
interface Pending<T>{resolve(value:T):void;reject(error:Error):void}
class EventQueue implements AsyncIterable<QuickStreamEvent>{
 private values:QuickStreamEvent[]=[];private waiting:Pending<IteratorResult<QuickStreamEvent>>|null=null;private failure:Error|null=null;private closed=false
 push(value:QuickStreamEvent):void{if(this.closed)return;if(this.waiting){const p=this.waiting;this.waiting=null;p.resolve({value,done:false})}else this.values.push(value)}
 close():void{if(this.closed)return;this.closed=true;if(this.waiting){const p=this.waiting;this.waiting=null;p.resolve({value:undefined,done:true})}}
 fail(error:unknown):void{if(this.closed)return;this.failure=error instanceof Error?error:new Error(String(error));this.closed=true;if(this.waiting){const p=this.waiting;this.waiting=null;p.reject(this.failure)}}
 [Symbol.asyncIterator]():AsyncIterator<QuickStreamEvent>{return{next:()=>{const value=this.values.shift();if(value)return Promise.resolve({value,done:false});if(this.failure)return Promise.reject(this.failure);if(this.closed)return Promise.resolve({value:undefined,done:true});return new Promise((resolve,reject)=>{this.waiting={resolve,reject}})}}}
}
function payload(event:QuickWireEvent):Record<string,unknown>{return typeof event.payload==='object'&&event.payload?event.payload:event}
function textField(event:QuickWireEvent,key:string):string|undefined{const value=payload(event)[key];return typeof value==='string'&&value?value:undefined}
async function bytes(data:unknown):Promise<Uint8Array|string|null>{if(typeof data==='string')return data;if(data instanceof ArrayBuffer)return new Uint8Array(data);if(ArrayBuffer.isView(data))return new Uint8Array(data.buffer,data.byteOffset,data.byteLength);if(typeof Blob!=='undefined'&&data instanceof Blob)return new Uint8Array(await data.arrayBuffer());return null}
export class QuickConnection{
 private readonly queue=new EventQueue();private assistantMessageId:string|undefined;private finalText:string|undefined;private done=false;private closed=false;private signal:AbortSignal|undefined;private activity:{pulse():void}|undefined;private approvalResolver:QuickApprovalResolver|undefined
 private connectedResolve:()=>void=()=>{};private readonly connected=new Promise<void>((resolve)=>{this.connectedResolve=resolve})
 private readonly keepalive:ReturnType<typeof setInterval>;private readonly refresh:ReturnType<typeof setInterval>
 private constructor(private readonly socket:WebSocket,private readonly outpost:AwsQuickOutpost,private readonly threadId:string,private readonly preApprovedTools?:string[],private readonly invokingOutpostId?:string,private readonly appVersion?:string,private readonly rawObserver?:QuickRawObserver){
  this.keepalive=setInterval(()=>this.send({type:'ping',payload:{timestamp:Date.now()}}),25_000)
  this.refresh=setInterval(()=>{void this.outpost.session(true).then((fresh)=>this.send({type:'token_refresh',token:fresh.jwt})).catch(()=>undefined)},60_000)
  socket.onerror=()=>{if(!this.done)this.queue.fail(new LlmError('AWS Quick WebSocket transport failed.','TRANSPORT'))}
  socket.onclose=(event)=>{if(!this.done&&!this.closed)this.queue.fail(new LlmError(`AWS Quick WebSocket closed before completion (code ${event.code}).`,'STREAM_CLOSED'))}
  socket.onmessage=(message)=>{void this.receive(message.data).catch((error)=>this.queue.fail(error instanceof LlmError?error:new LlmError('AWS Quick returned an unreadable stream event: '+(error instanceof Error?error.message:String(error)),'INVALID_RESPONSE',{cause:error})))}
 }
 static async open(input:{outpost:AwsQuickOutpost;threadId:string;outpostId?:string;workingSessionId?:string;preApprovedTools?:string[];signal?:AbortSignal;activity?:{pulse():void};onRawEvent?:QuickRawObserver}):Promise<QuickConnection>{
  if(input.signal?.aborted)throw new LlmError('AWS Quick turn was cancelled before connecting.','ABORTED')
  const session=await input.outpost.session(true)
  if(!isQuickChatHost(session.wsHost))throw new Error(`Refusing untrusted AWS Quick WebSocket host: ${session.wsHost}`)
  if(session.provider==='gateway'||session.provider==='social_gateway')throw new Error('This AWS Quick account selected the legacy Gateway transport; this line supports the current AIDP transport.')
  const outpostId=input.outpostId??randomUUID();const workingSessionId=input.workingSessionId??randomUUID()
  const url=new URL(`wss://${session.wsHost}${session.wsPath||QUICK_CHAT_WS_PATH}`);url.searchParams.set('surfaceType',session.surface);url.searchParams.set('outpostId',outpostId);url.searchParams.set('workingSessionId',workingSessionId);url.searchParams.set('channel','prod');if(session.provider!=='enterprise')url.searchParams.set('token',session.jwt)
  const socket=new WebSocket(url,{headers:{Authorization:`Bearer ${session.jwt}`,'X-Surface-Type':session.surface,'X-Agent-Service-Type':'UNIFIED_QUICK','X-Outpost-Id':outpostId,'X-Working-Session-Id':workingSessionId,'X-Channel':'prod'}});socket.binaryType='arraybuffer'
  const connection=new QuickConnection(socket,input.outpost,input.threadId,input.preApprovedTools,outpostId,session.appVersion,input.onRawEvent);connection.setSignal(input.signal);connection.activity=input.activity
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{reject(new LlmError('AWS Quick WebSocket connection timed out.','TIMEOUT'));connection.close()},30_000);socket.onopen=()=>{clearTimeout(timer);connection.send(quickSessionConnect(session.actorArn,outpostId,session.appVersion));resolve()};socket.onerror=()=>{clearTimeout(timer);reject(new LlmError('AWS Quick WebSocket failed during connection.','TRANSPORT'))}})
  await Promise.race([connection.connected,new Promise<never>((_,reject)=>{const timer=setTimeout(()=>{connection.close();reject(new LlmError('AWS Quick did not confirm the connected session.','TIMEOUT'))},30_000);void connection.connected.finally(()=>clearTimeout(timer)).catch(()=>undefined)})])
  if(input.outpostId)await input.outpost.invokeAgentCapabilities(session,workingSessionId,outpostId)
  return connection
 }
 setSignal(signal:AbortSignal|undefined):void{if(this.signal===signal)return;this.signal?.removeEventListener('abort',this.onAbort);this.signal=signal;this.signal?.addEventListener('abort',this.onAbort,{once:true})}
 setActivity(activity:{pulse():void}|undefined):void{this.activity=activity}
 setApprovalResolver(resolver:QuickApprovalResolver|undefined):void{this.approvalResolver=resolver}
 private approves(request:{toolName?:string;actionId?:string;connectorId?:string}):boolean{try{return this.approvalResolver?.(request)===true}catch{return false}}
 private readonly onAbort=()=>{if(this.assistantMessageId)this.send(quickStopGeneration(this.threadId,this.assistantMessageId));this.finish('cancelled');this.close()}
 private send(value:unknown):void{if(this.socket.readyState===WebSocket.OPEN)this.socket.send(encodeQuickInput(value))}
 sendUser(text:string,mode:AwsQuickMode,effort?:AwsQuickEffort,attachments?:QuickImageAttachment[],customPrompt?:string):void{if(this.done||this.closed)throw new LlmError('Quick connection is closed.','STREAM_CLOSED');this.send(quickUserMessage({text,threadId:this.threadId,mode,effort,preApprovedTools:this.preApprovedTools,invokingOutpostId:this.invokingOutpostId,appVersion:this.appVersion,attachments,customPrompt,userLocale:Intl.DateTimeFormat().resolvedOptions().locale,userTimezone:Intl.DateTimeFormat().resolvedOptions().timeZone}))}
 answerTool(call:QuickToolCall,result:string|QuickResultContent[],isError=false):void{if(this.done||this.closed||this.socket.readyState!==WebSocket.OPEN)throw new LlmError('Quick tool result cannot be sent because the connection is closed.','STREAM_CLOSED');const content=typeof result==='string'?[{type:'text' as const,text:result}]:result;this.send({type:'tool_result',payload:{tool_call_id:call.id,result:{content},error:isError?(typeof result==='string'?result:'Tool execution failed.'):null}})}
 events():AsyncIterable<QuickStreamEvent>{return this.queue}
 private finish(reason:'stop'|'cancelled',text?:string):void{if(this.done)return;this.done=true;this.queue.push({kind:'done',reason,...(text?{text}:{})});this.queue.close()}
 private async receive(data:unknown):Promise<void>{
  const raw=await bytes(data);if(raw===null)return
  const event=typeof raw==='string'?JSON.parse(raw) as QuickWireEvent:decodeQuickOutput(raw);if(!event)return;this.rawObserver?.(event);this.activity?.pulse()
  const thread=textField(event,'thread_id')??event.thread_id;if(thread&&thread!==this.threadId)return
  const type=event.type
  const body=payload(event)
  if((type==='status'&&body.type==='permission_request')||type==='permission_request'){
   // Quick waits for an answer before it emits the tool call. DSH-owned tools are
   // approved once here because DSH applies its own permission prompt when it runs
   // them; anything else is declined so the turn moves on instead of hanging.
   const request=readQuickPermissionRequest(body,this.threadId)
   this.send(quickPermissionReply(request,this.approves({...(request.toolName?{toolName:request.toolName}:{}),actionId:request.actionId,connectorId:request.connectorId})));return
  }
  if(type==='approval_requested'){
   const toolName=typeof body.tool_name==='string'?body.tool_name:typeof body.toolName==='string'?body.toolName:undefined
   const reply=quickApprovalDecision(body,this.threadId,this.approves(toolName?{toolName}:{}));if(reply)this.send(reply);return
  }
  if(type==='connected'){const user=payload(event).user;this.send({type:'federate_status',payload:{user}});this.connectedResolve()}
  if(type==='message_start')this.assistantMessageId=textField(event,'message_id')??event.message_id??this.assistantMessageId
  if(type==='text_delta'||type==='thinking_delta'){const delta=textField(event,'delta');if(delta)this.queue.push({kind:type==='text_delta'?'text':'reasoning',delta});return}
  if(type==='text_complete'){this.finalText=textField(event,'text')??this.finalText;return}
  if(type==='tool_call'||type==='outpost_tool_call'){
   const p=payload(event);const id=textField(event,'tool_call_id')??textField(event,'id');const name=textField(event,'tool_name')??textField(event,'name')
   if(id&&name){const args=p.arguments??p.input??{};this.queue.push({kind:'tool-call',call:{id,name,argumentsText:unwrapQuickToolArguments(args)}})}return
  }
  if(type==='turn_aborted'){this.finish('cancelled');return}
  if(type==='message_complete'||type==='stream_ended'){this.finish('stop',textField(event,'text')??this.finalText);return}
  if(type==='error'||type==='guardrail_blocked'){const message=textField(event,'message')??textField(event,'error')??'AWS Quick returned an error.';const oversize=/over the \d+ ?KB size limit|size limit/i.test(message);this.queue.fail(new LlmError(message,type==='guardrail_blocked'||oversize?'INVALID_REQUEST':'SERVER'))}
 }
 close():void{if(this.closed)return;this.closed=true;clearInterval(this.keepalive);clearInterval(this.refresh);this.signal?.removeEventListener('abort',this.onAbort);this.queue.close();if(this.socket.readyState===WebSocket.OPEN||this.socket.readyState===WebSocket.CONNECTING)this.socket.close(1000,'Complete')}
}
export async function* streamQuickTurn(input:{outpost:AwsQuickOutpost;text:string;threadId:string;mode:AwsQuickMode;effort?:AwsQuickEffort;signal?:AbortSignal;activity?:{pulse():void}}):AsyncGenerator<QuickStreamEvent>{
 const connection=await QuickConnection.open(input)
 try{connection.sendUser(input.text,input.mode,input.effort);yield* connection.events()}finally{connection.close()}
}
