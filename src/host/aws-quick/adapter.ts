import {randomUUID} from 'node:crypto'
import type {ImageAttachmentRef} from '@deepseek-ai/dsh-attachment'
import {LlmAdapter,resolveRetryPolicy,type GenerateOptions as HarnessGenerateOptions,type LlmModelInfo,type LlmProviderInfo,type LlmResolvedModelInfo,type PreparedAdapterCall,type ResolvedRetryPolicy,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {localizedProviderName} from '../common/i18n/index.ts'
import {LlmError,normalizeGenerateOptions,type ContentBlock,type GenerateOptions,type Message,type ToolResultBlock} from '../common/llm-compat.ts'
import {STREAM_IDLE_TIMEOUT_CODE,STREAM_IDLE_TIMEOUT_MS,wrapStreamWithWatchdog} from '../common/idle-watchdog.ts'
import {requestImageTargetOrOriginal,resolveRequestImages,type AttachmentImageReader} from '../common/request-images.ts'
import {quickImageAttachments,quickImageLabel,quickToolResultContent,type QuickResultContent} from './images.ts'
import type {AwsQuickSettingsStore} from './settings.ts'
import {findQuickModel,normalizeQuickEffort,PROVIDER_NAME,QUICK_MODELS,toQuickModelInfo,toQuickResolvedModel} from './types.ts'
import {QuickConnection,type QuickToolCall} from './client.ts'
import {QUICK_DSH_TOOL_POLICY} from './protocol.ts'
import type {AwsQuickOutpost} from './outpost.ts'
import type {AwsQuickToolBridge,QuickToolCatalog} from './tool-bridge.ts'

const QUICK_STREAM_IDLE_TIMEOUT_MS=600_000
const RETRY_POLICY=resolveRetryPolicy({mode:'normal',maxRetries:2,retryableCodes:['TRANSPORT','SERVER','TIMEOUT','STREAM_CLOSED',STREAM_IDLE_TIMEOUT_CODE],backoff:{initialDelayMs:1500,maxDelayMs:15000,jitterRatio:0.2}},'aws-quick.retry')
interface ThreadState{threadId:string;covered:number;fingerprint:string;model:string;effort?:string;toolFingerprint?:string}
interface LiveTurn{connection:QuickConnection;state:ThreadState;catalog?:QuickToolCatalog;pending:Map<string,QuickToolCall>}
function blockText(block:ContentBlock):string{const b=block as unknown as Record<string,unknown>;if(b.type==='text'&&typeof b.text==='string')return b.text;if(b.type==='tool-call')return `[Tool call ${String(b.name??'unknown')}: ${String(b.arguments??'')}]`;if(b.type==='tool-result'&&Array.isArray(b.content))return `[Tool result]\n${(b.content as ContentBlock[]).map(blockText).filter(Boolean).join('\n')}`;if(b.type==='image')return quickImageLabel(block);if(b.type==='image-url')throw new LlmError('AWS Quick requires an admitted DSH image attachment, not a remote image URL.','INVALID_REQUEST');return ''}
function messageText(message:Message):string{return message.content.map(blockText).filter(Boolean).join('\n')}
function renderMessage(message:Message):string{return `<${message.role}>\n${messageText(message)}\n</${message.role}>`}
function renderTranscript(messages:Message[]):string{return `The following is the complete DSH conversation. Continue from its latest user request; do not repeat earlier tasks.\n\n${messages.map(renderMessage).join('\n\n')}`}
function fingerprint(messages:Message[],covered:number):string{return JSON.stringify(messages.slice(0,covered).map((m)=>[m.role,messageText(m),m.content.filter((block)=>block.type==='image').map((block)=>(block as unknown as {attachment?:unknown}).attachment)]))}
function assertSupported(options:GenerateOptions):void{const unsupported:string[]=[];if(options.temperature!==undefined)unsupported.push('temperature');if(options.stop!==undefined)unsupported.push('stop');if(unsupported.length)throw new LlmError(`AWS Quick cannot express ${unsupported.join(', ')}.`,'UNSUPPORTED_OPTION')}
function collectResults(messages:Message[],images:Awaited<ReturnType<typeof resolveRequestImages>>):Array<{id:string;content:QuickResultContent[];isError:boolean}>{
 const out:Array<{id:string;content:QuickResultContent[];isError:boolean}>=[]
 for(const message of messages)for(const block of message.content){if(block.type!=='tool-result')continue;const result=block as ToolResultBlock;out.push({id:result.toolCallId,content:quickToolResultContent(result.content,images),isError:result.isError===true})}
 return out
}
export class AwsQuickAdapter extends LlmAdapter{
 private readonly threads=new Map<string,ThreadState>();private readonly live=new Map<string,LiveTurn>();private readonly active=new Set<string>()
 constructor(private readonly options:{settings:AwsQuickSettingsStore;outpost:AwsQuickOutpost;toolBridge?:AwsQuickToolBridge;attachments?:AttachmentImageReader;openConnection?:typeof QuickConnection.open}){super()}
 imageRequestTarget(_provider:string,_model:string,image:ImageAttachmentRef){return requestImageTargetOrOriginal(image)}
 providerInfo(provider:string):LlmProviderInfo{return{id:provider,name:localizedProviderName(provider,PROVIDER_NAME)}}
 providerRetryPolicy():ResolvedRetryPolicy{return RETRY_POLICY}
 async listModels(provider:string):Promise<readonly LlmModelInfo[]>{const settings=await this.options.settings.read();if(!settings.enabled)return[];const enabled=settings.enabledModelIds;return QUICK_MODELS.filter((m)=>enabled===null||enabled.includes(m.id)).map((m)=>toQuickModelInfo(provider,m))}
 async resolveModel(provider:string,model:string):Promise<LlmResolvedModelInfo>{return toQuickResolvedModel(provider,findQuickModel(model))}
 async prepareCall(provider:string,model:string):Promise<PreparedAdapterCall>{return{model:await this.resolveModel(provider,model),stream:(options)=>this.stream(options)}}
 stream(options:HarnessGenerateOptions):AsyncIterable<StreamChunk>{return wrapStreamWithWatchdog((signal,activity)=>this.run(options,signal,activity),options.signal,QUICK_STREAM_IDLE_TIMEOUT_MS,STREAM_IDLE_TIMEOUT_CODE,PROVIDER_NAME,QUICK_STREAM_IDLE_TIMEOUT_MS)}
 private compatible(state:ThreadState,options:GenerateOptions,model:string,effort:string|undefined,toolFingerprint:string|undefined):boolean{return state.model===model&&state.effort===effort&&state.toolFingerprint===toolFingerprint&&fingerprint(options.messages,state.covered)===state.fingerprint}
 private async *run(raw:HarnessGenerateOptions,signal:AbortSignal,activity:{pulse():void}):AsyncGenerator<StreamChunk>{
  const options=normalizeGenerateOptions(raw);assertSupported(options)
  const settings=await this.options.settings.read();if(!settings.enabled)throw new LlmError('AWS Quick is disabled.','PROVIDER_DISABLED')
  const sessionId=String(options.sessionId??'unscoped-session');const activeKey=sessionId+'\0'+(options.purpose??'main');if(this.active.has(activeKey))throw new LlmError('AWS Quick already has a turn running for this DSH session and purpose.','RATE_LIMIT');this.active.add(activeKey)
  let turn:LiveTurn|undefined;let keepLive=false
  try{
   const model=findQuickModel(options.model);const requested=normalizeQuickEffort(options.reasoningEffort)??settings.defaultReasoningEffort??undefined;const effort=requested&&model.efforts.includes(requested)?requested:undefined
   const tools=options.tools??[];const catalog=tools.length>0?await this.options.toolBridge?.ensure(tools):undefined
   if(tools.length>0&&!catalog)throw new LlmError('AWS Quick DSH tool bridge is not configured.','PROVIDER_DISABLED')
   const previous=options.purpose?undefined:this.live.get(sessionId)
   if(previous&&this.compatible(previous.state,options,model.id,effort,catalog?.fingerprint)){
    turn=previous;turn.catalog=catalog;turn.connection.setSignal(signal);turn.connection.setActivity(activity)
    const freshMessages=options.messages.slice(previous.state.covered);const images=await resolveRequestImages({...options,messages:freshMessages},this.options.attachments,signal)
    const results=collectResults(freshMessages,images)
    if(results.length===0&&previous.pending.size>0)throw new LlmError('AWS Quick tool continuation requires the DSH tool result.','INVALID_REQUEST')
    for(const result of results){const call=previous.pending.get(result.id);if(!call)throw new LlmError(`Unknown Quick tool result id: ${result.id}`,'INVALID_REQUEST');this.options.toolBridge?.settle(call.id,result.content,result.isError);turn.connection.answerTool(call,result.content,result.isError);previous.pending.delete(result.id)}
   }else{
    if(previous){previous.connection.close();this.live.delete(sessionId)}
    const modelState=findQuickModel(options.model)
    let threadId:string=randomUUID();let text='';let outboundMessages=options.messages;const dormant=options.purpose?undefined:this.threads.get(sessionId)
    if(dormant&&this.compatible(dormant,options,modelState.id,effort,catalog?.fingerprint)){
     const latest=options.messages.slice(dormant.covered).filter((m)=>m.role==='user').at(-1);if(latest&&messageText(latest).trim()){threadId=dormant.threadId;text=messageText(latest);outboundMessages=[latest]}
    }
    if(!text)text=renderTranscript(options.messages)
    if(!options.messages.some((message)=>messageText(message).trim()))throw new LlmError('AWS Quick received an empty prompt.','INVALID_REQUEST')
    const open=this.options.openConnection??QuickConnection.open
    const images=await resolveRequestImages({...options,messages:outboundMessages},this.options.attachments,signal);const attachments=quickImageAttachments(outboundMessages,images)
    const connection=await open({outpost:this.options.outpost,threadId,outpostId:catalog?.outpostId,preApprovedTools:tools.map((tool)=>'dsh_quick__'+tool.name),signal,activity})
    turn={connection,catalog,pending:new Map(),state:{threadId,covered:0,fingerprint:'',model:modelState.id,...(effort?{effort}:{}),...(catalog?{toolFingerprint:catalog.fingerprint}:{})}}
    connection.sendUser(text,modelState.mode,effort,attachments,tools.length>0?QUICK_DSH_TOOL_POLICY:undefined)
   }
   if(!turn)throw new LlmError('AWS Quick failed to initialize its connection.','SERVER')
   const currentTurn=turn
   let open:{index:number;kind:'text'|'reasoning';text:string}|null=null;let index=0
   const close=():StreamChunk|undefined=>{if(!open)return undefined;const current=open;open=null;return{type:'block-end',index:current.index,block:current.kind==='text'?{type:'text',text:current.text}:{type:'reasoning',text:current.text}} as StreamChunk}
   for await(const event of currentTurn.connection.events()){
    if(event.kind==='tool-call'){
     const original=currentTurn.catalog?.resolve(event.call.name)??null
     if(!original){currentTurn.connection.answerTool(event.call,'This tool is not offered by the current DSH session.',true);continue}
     const call={...event.call,name:original};currentTurn.pending.set(call.id,call);this.options.toolBridge?.track(call)
     const closing=close();if(closing)yield closing
     const toolIndex=index++;yield{type:'block-start',index:toolIndex,blockType:'tool-call'} as StreamChunk
     yield{type:'tool-call-delta',index:toolIndex,id:call.id,name:original,argumentsDelta:call.argumentsText} as StreamChunk
     yield{type:'block-end',index:toolIndex,block:{type:'tool-call',id:call.id,name:original,arguments:call.argumentsText}} as StreamChunk
     currentTurn.state={...currentTurn.state,covered:options.messages.length,fingerprint:fingerprint(options.messages,options.messages.length)}
     if(options.purpose===undefined)this.live.set(sessionId,currentTurn)
     keepLive=options.purpose===undefined
     if(keepLive){currentTurn.connection.setSignal(undefined);currentTurn.connection.setActivity(undefined)}
     yield{type:'finish',reason:{kind:'tool-calls'}}
     return
    }
    if(event.kind==='done'){
     const closing=close();if(closing)yield closing
     if(event.reason==='cancelled')throw new LlmError('AWS Quick turn was cancelled.','ABORTED')
     yield{type:'finish',reason:{kind:'stop'}}
     if(options.purpose===undefined){this.threads.set(sessionId,{...currentTurn.state,covered:options.messages.length,fingerprint:fingerprint(options.messages,options.messages.length)});this.live.delete(sessionId)}
     await this.options.settings.update({lastTurnAt:Date.now()})
     return
    }
    const currentOpen=open as {index:number;kind:'text'|'reasoning';text:string}|null
    if(currentOpen?.kind!==event.kind){const closing=close();if(closing)yield closing;open={kind:event.kind,index:index++,text:''};yield{type:'block-start',index:open.index,blockType:event.kind} as StreamChunk}
    open!.text+=event.delta;yield{type:event.kind==='text'?'text-delta':'reasoning-delta',index:open!.index,text:event.delta} as StreamChunk
   }
   throw new LlmError('AWS Quick ended without a terminal event.','INVALID_RESPONSE')
  }finally{
   this.active.delete(activeKey)
   if(turn&&!keepLive){for(const call of turn.pending.values())this.options.toolBridge?.settle(call.id,[{type:'text',text:'The Quick DSH turn closed before the tool result arrived.'}],true);turn.pending.clear();turn.connection.close();if(options.purpose===undefined&&this.live.get(sessionId)===turn)this.live.delete(sessionId)}
  }
 }
 async dispose():Promise<void>{for(const turn of this.live.values())turn.connection.close();this.live.clear();this.threads.clear();await this.options.toolBridge?.dispose();await this.options.outpost.dispose()}
}
