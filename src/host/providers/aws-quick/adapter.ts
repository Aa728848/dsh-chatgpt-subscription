import {randomUUID} from 'node:crypto'
import type {ImageAttachmentRef} from '@deepseek-ai/dsh-attachment'
import {LlmAdapter,resolveRetryPolicy,type GenerateOptions as HarnessGenerateOptions,type LlmModelInfo,type LlmProviderInfo,type LlmResolvedModelInfo,type PreparedAdapterCall,type ResolvedRetryPolicy,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {localizedProviderName} from '../../common/i18n/index.ts'
import {LlmError,extractSystemText,normalizeGenerateOptions,type ContentBlock,type GenerateOptions,type Message,type ToolResultBlock} from '../../common/llm-compat.ts'
import {STREAM_IDLE_TIMEOUT_CODE,STREAM_IDLE_TIMEOUT_MS,wrapStreamWithWatchdog} from '../../common/idle-watchdog.ts'
import {requestImageTargetOrOriginal,resolveRequestImages,type AttachmentImageReader} from '../../common/request-images.ts'
import {quickImageAttachments,quickImageLabel,quickToolResultContent,type QuickResultContent} from './images.ts'
import type {AwsQuickSettingsStore} from './settings.ts'
import {findQuickModel,normalizeQuickEffort,PROVIDER_NAME,QUICK_MODELS,toQuickModelInfo,toQuickResolvedModel} from './types.ts'
import {QuickConnection,type QuickToolCall} from './client.ts'
import {QUICK_DSH_CLIENT_POLICY,QUICK_DSH_TOOL_POLICY} from './protocol.ts'
import {decisionResponseText,decisionsToAskArguments,QuickMarkupFilter,renderDecisionsAsText,type QuickDecision} from './markup.ts'
import type {AwsQuickOutpost} from './outpost.ts'
import type {AwsQuickToolBridge,QuickToolCatalog} from './tool-bridge.ts'
import {SessionEffortMemory} from '../../common/session-effort-memory.ts'

const QUICK_STREAM_IDLE_TIMEOUT_MS=600_000
const RETRY_POLICY=resolveRetryPolicy({mode:'normal',maxRetries:2,retryableCodes:['TRANSPORT','SERVER','TIMEOUT','STREAM_CLOSED',STREAM_IDLE_TIMEOUT_CODE],backoff:{initialDelayMs:1500,maxDelayMs:15000,jitterRatio:0.2}},'aws-quick.retry')
interface ThreadState{threadId:string;covered:number;fingerprint:string;model:string;effort?:string;toolFingerprint?:string}
interface LiveTurn{connection:QuickConnection;state:ThreadState;catalog?:QuickToolCatalog;pending:Map<string,QuickToolCall>}
function blockText(block:ContentBlock):string{const b=block as unknown as Record<string,unknown>;if(b.type==='text'&&typeof b.text==='string')return b.text;if(b.type==='tool-call')return `[Tool call ${String(b.name??'unknown')}: ${String(b.arguments??'')}]`;if(b.type==='tool-result'&&Array.isArray(b.content))return `[Tool result]\n${(b.content as ContentBlock[]).map(blockText).filter(Boolean).join('\n')}`;if(b.type==='image')return quickImageLabel(block);if(b.type==='image-url')throw new LlmError('AWS Quick requires an admitted DSH image attachment, not a remote image URL.','INVALID_REQUEST');return ''}
function messageText(message:Message):string{return message.role==='system'?extractSystemText(message.content):message.content.map(blockText).filter(Boolean).join('\n')}
function renderMessage(message:Message):string{return `<${message.role}>\n${messageText(message)}\n</${message.role}>`}
function renderTranscript(messages:Message[]):string{const conversation=messages.filter((message)=>message.role!=='system'&&message.role!=='developer');return `The following is the complete DSH conversation. Continue from its latest user request; do not repeat earlier tasks.\n\n${conversation.map(renderMessage).join('\n\n')}`}
function systemContext(messages:Message[]):string{return messages.filter((message)=>message.role==='system'||message.role==='developer').map(messageText).filter((text)=>text.trim()).join('\n\n')}
function fingerprint(messages:Message[],covered:number):string{return JSON.stringify(messages.slice(0,covered).map((m)=>[m.role,messageText(m),m.content.filter((block)=>block.type==='image').map((block)=>(block as unknown as {attachment?:unknown}).attachment)]))}
/** DSH tool that renders a question card; Quick decisions are projected onto it. */
const ASK_TOOL='ask_user_question'
const MAX_DECISION_CALLS=64
function resultText(block:ToolResultBlock):string{return block.content.map((item)=>item.type==='text'?item.text:'').filter(Boolean).join('\n')}
/** Text DSH appended after a tool round (plan-mode notices, reminders, steering) that is not itself a tool result. */
function extraContext(messages:Message[]):string{return messages.filter((message)=>message.role!=='assistant').map((message)=>message.content.filter((block)=>block.type!=='tool-result').map(blockText).filter(Boolean).join('\n')).filter((text)=>text.trim()).join('\n\n')}
function assertSupported(options:GenerateOptions):void{const unsupported:string[]=[];if(options.temperature!==undefined)unsupported.push('temperature');if(options.stop!==undefined)unsupported.push('stop');if(unsupported.length)throw new LlmError(`AWS Quick cannot express ${unsupported.join(', ')}.`,'UNSUPPORTED_OPTION')}
function collectResults(messages:Message[],images:Awaited<ReturnType<typeof resolveRequestImages>>):Array<{id:string;content:QuickResultContent[];isError:boolean}>{
 const out:Array<{id:string;content:QuickResultContent[];isError:boolean}>=[]
 for(const message of messages)for(const block of message.content){if(block.type!=='tool-result')continue;const result=block as ToolResultBlock;out.push({id:result.toolCallId,content:quickToolResultContent(result.content,images),isError:result.isError===true})}
 return out
}
/** AWS Quick rejects a single chat message above this size with a deterministic error. */
export const QUICK_MAX_REQUEST_BYTES=64*1024
/** Bytes held back for the JSON envelope, ids, the pre-approved tool list and mode/effort fields Quick also counts. */
const QUICK_REQUEST_RESERVE_BYTES=8192
const SYSTEM_TRIM_MARKER='\n\n[DSH system context truncated to fit the AWS Quick request size limit]'
const TRANSCRIPT_TRIM_MARKER='[Earlier conversation trimmed to fit the AWS Quick request size limit]\n\n'
function utf8Bytes(value:string):number{return Buffer.byteLength(value,'utf8')}
/** Longest prefix of `value` whose UTF-8 length is at most `maxBytes` (never splits a surrogate pair). */
function fitPrefix(value:string,maxBytes:number):string{if(maxBytes<=0)return'';if(utf8Bytes(value)<=maxBytes)return value;let lo=0;let hi=value.length;let best=0;while(lo<=hi){const mid=(lo+hi)>>1;if(utf8Bytes(value.slice(0,mid))<=maxBytes){best=mid;lo=mid+1}else hi=mid-1}if(best>0&&best<value.length){const code=value.charCodeAt(best-1);if(code>=0xd800&&code<=0xdbff)best-=1}return value.slice(0,best)}
/** Longest suffix of `value` whose UTF-8 length is at most `maxBytes` (keeps the latest content). */
function fitSuffix(value:string,maxBytes:number):string{if(maxBytes<=0)return'';if(utf8Bytes(value)<=maxBytes)return value;let lo=0;let hi=value.length;let best=0;while(lo<=hi){const mid=(lo+hi)>>1;if(utf8Bytes(value.slice(value.length-mid))<=maxBytes){best=mid;lo=mid+1}else hi=mid-1}if(best>0&&best<value.length){const code=value.charCodeAt(value.length-best);if(code>=0xdc00&&code<=0xdfff)best-=1}return value.slice(value.length-best)}
/** The pieces that make up one outgoing Quick message. */
export interface QuickRequestParts{text:string;systemContext:string;policy:string}
/** The message that will actually be sent, after any budget trimming. */
export interface QuickRequestPlan{text:string;customPrompt:string|undefined;truncated:boolean}
/**
 * Fit one outgoing Quick message inside Quick's per-message size limit.
 *
 * Quick refuses a chat message above 64 KB with a deterministic, non-retryable
 * error. A DSH preset can put a very large block in its system prompt (the
 * `Writing code for run_code` section alone measured ~74 KB in issue #126), and
 * the adapter used to paste that whole block into `custom_prompt`, so a one-line
 * user message was rejected before it ever left the plugin. This budgets the
 * message by its UTF-8 byte length and degrades in a fixed priority order:
 *
 * 1. Keep the latest user input and the tool/client policy (the approval rules)
 *    intact whenever they fit on their own; only the transcript tail is trimmed
 *    if the conversation itself is too large.
 * 2. Trim the system context (where a big preset prompt lives) to the remaining
 *    room, ending it with a truncation marker.
 * 3. If even the essentials cannot fit, throw a non-retryable {@link LlmError}
 *    telling the user to switch preset or shorten the input, instead of sending
 *    a request Quick will reject.
 *
 * @param parts - Latest user text, the system/developer context, and the fixed policy.
 * @param cap - Byte budget; defaults to Quick's limit minus the envelope reserve.
 */
export function budgetQuickRequest(parts:QuickRequestParts,cap:number=QUICK_MAX_REQUEST_BYTES-QUICK_REQUEST_RESERVE_BYTES):QuickRequestPlan{
 const custom=(systemContext:string):string|undefined=>[systemContext,parts.policy].filter(Boolean).join('\n\n')||undefined
 const customBytes=(systemContext:string):number=>{const built=custom(systemContext);return built?utf8Bytes(built):0}
 let text=parts.text
 // 1. If the transcript alone plus policy overflows, keep the tail (latest turns).
 if(utf8Bytes(text)+customBytes('')>cap){
  const room=cap-customBytes('')-utf8Bytes(TRANSCRIPT_TRIM_MARKER)
  if(room<=0)throw new LlmError('AWS Quick request is larger than its '+QUICK_MAX_REQUEST_BYTES+' byte limit even with the conversation trimmed; start a new session or shorten the input.','INVALID_REQUEST')
  text=TRANSCRIPT_TRIM_MARKER+fitSuffix(text,room)
 }
 // 2. Trim the system context into whatever room is left; keep policy untouched.
 let systemContext=parts.systemContext
 if(utf8Bytes(text)+customBytes(systemContext)>cap){
  // Reserve the two bytes the systemContext+policy join inserts, or the final
  // custom prompt lands two bytes over the budget and the guard below trips.
  const room=cap-utf8Bytes(text)-customBytes('')-utf8Bytes(SYSTEM_TRIM_MARKER)-2
  systemContext=room>0?fitPrefix(systemContext,room)+SYSTEM_TRIM_MARKER:''
  if(utf8Bytes(text)+customBytes(systemContext)>cap)throw new LlmError('AWS Quick request is larger than its '+QUICK_MAX_REQUEST_BYTES+' byte limit even after dropping system context; switch to a preset with a smaller prompt or shorten the conversation.','INVALID_REQUEST')
 }
 return{text,customPrompt:custom(systemContext),truncated:text!==parts.text||systemContext!==parts.systemContext}
}
export class AwsQuickAdapter extends LlmAdapter{
 private readonly threads=new Map<string,ThreadState>();private readonly live=new Map<string,LiveTurn>();private readonly active=new Set<string>();private readonly decisionCalls=new Map<string,QuickDecision[]>()
 /** Remembers the last main turn's effort so an unnamed auxiliary request repeats it instead of the settings default. */
 private readonly effortMemory=new SessionEffortMemory()
 constructor(private readonly options:{settings:AwsQuickSettingsStore;outpost:AwsQuickOutpost;toolBridge?:AwsQuickToolBridge;attachments?:AttachmentImageReader;openConnection?:typeof QuickConnection.open}){super()}
 imageRequestTarget(_provider:string,_model:string,image:ImageAttachmentRef){return requestImageTargetOrOriginal(image)}
 providerInfo(provider:string):LlmProviderInfo{return{id:provider,name:localizedProviderName(provider,PROVIDER_NAME)}}
 providerRetryPolicy():ResolvedRetryPolicy{return RETRY_POLICY}
 async listModels(provider:string):Promise<readonly LlmModelInfo[]>{const settings=await this.options.settings.read();if(!settings.enabled)return[];const enabled=settings.enabledModelIds;return QUICK_MODELS.filter((m)=>enabled===null||enabled.includes(m.id)).map((m)=>toQuickModelInfo(provider,m))}
 async resolveModel(provider:string,model:string):Promise<LlmResolvedModelInfo>{return toQuickResolvedModel(provider,findQuickModel(model))}
 async prepareCall(provider:string,model:string):Promise<PreparedAdapterCall>{return{model:await this.resolveModel(provider,model),stream:(options)=>this.stream(options)}}
 stream(options:HarnessGenerateOptions):AsyncIterable<StreamChunk>{return wrapStreamWithWatchdog((signal,activity)=>this.run(options,signal,activity),options.signal,QUICK_STREAM_IDLE_TIMEOUT_MS,STREAM_IDLE_TIMEOUT_CODE,PROVIDER_NAME,QUICK_STREAM_IDLE_TIMEOUT_MS)}
 private approvalResolver(catalog:QuickToolCatalog|undefined){return(request:{toolName?:string;actionId?:string}):boolean=>!!catalog&&[request.toolName,request.actionId].some((name)=>!!name&&catalog.resolve(name)!==null)}
 private rememberDecision(id:string,decisions:QuickDecision[]):void{this.decisionCalls.set(id,decisions);while(this.decisionCalls.size>MAX_DECISION_CALLS){const oldest=this.decisionCalls.keys().next().value;if(oldest===undefined)break;this.decisionCalls.delete(oldest)}}
 /** Quick-native answer text when the message answers a projected decision; undefined otherwise. */
 private decisionAnswer(message:Message):string|undefined{const parts:string[]=[];for(const block of message.content){if(block.type!=='tool-result')continue;const result=block as ToolResultBlock;const decisions=this.decisionCalls.get(result.toolCallId);if(!decisions)continue;this.decisionCalls.delete(result.toolCallId);parts.push(decisionResponseText(decisions,resultText(result)))}return parts.length?parts.join('\n'):undefined}
 private compatible(state:ThreadState,options:GenerateOptions,model:string,effort:string|undefined,toolFingerprint:string|undefined):boolean{return state.model===model&&state.effort===effort&&state.toolFingerprint===toolFingerprint&&fingerprint(options.messages,state.covered)===state.fingerprint}
 private async *run(raw:HarnessGenerateOptions,signal:AbortSignal,activity:{pulse():void}):AsyncGenerator<StreamChunk>{
  // Follow the session's remembered effort before the settings default fills one in, so an unnamed compaction/report reuses the main turn's effort.
  const options=this.effortMemory.follow(normalizeGenerateOptions(raw));assertSupported(options)
  const settings=await this.options.settings.read();if(!settings.enabled)throw new LlmError('AWS Quick is disabled.','PROVIDER_DISABLED')
  const sessionId=String(options.sessionId??'unscoped-session');const activeKey=sessionId+'\0'+(options.purpose??'main');if(this.active.has(activeKey))throw new LlmError('AWS Quick already has a turn running for this DSH session and purpose.','RATE_LIMIT');this.active.add(activeKey)
  let turn:LiveTurn|undefined;let keepLive=false
  try{
   const model=findQuickModel(options.model);const requested=normalizeQuickEffort(options.reasoningEffort)??settings.defaultReasoningEffort??undefined;const effort=requested&&model.efforts.includes(requested)?requested:undefined
   const tools=options.tools??[];const catalog=tools.length>0?await this.options.toolBridge?.ensure(tools):undefined
   if(tools.length>0&&!catalog)throw new LlmError('AWS Quick DSH tool bridge is not configured.','PROVIDER_DISABLED')
   const previous=options.purpose?undefined:this.live.get(sessionId)
   if(previous&&this.compatible(previous.state,options,model.id,effort,catalog?.fingerprint)){
    turn=previous;turn.catalog=catalog;turn.connection.setSignal(signal);turn.connection.setActivity(activity);turn.connection.setApprovalResolver?.(this.approvalResolver(catalog))
    const freshMessages=options.messages.slice(previous.state.covered);const images=await resolveRequestImages({...options,messages:freshMessages},this.options.attachments,signal)
    const results=collectResults(freshMessages,images)
    if(results.length===0&&previous.pending.size>0)throw new LlmError('AWS Quick tool continuation requires the DSH tool result.','INVALID_REQUEST')
    const extra=extraContext(freshMessages);const last=results.at(-1);if(extra&&last)last.content=[...last.content,{type:'text',text:'[DSH context added after this tool call]\n'+extra}]
    for(const result of results){const call=previous.pending.get(result.id);if(!call)throw new LlmError(`Unknown Quick tool result id: ${result.id}`,'INVALID_REQUEST');this.options.toolBridge?.settle(call.id,result.content,result.isError);turn.connection.answerTool(call,result.content,result.isError);previous.pending.delete(result.id)}
   }else{
    if(previous){previous.connection.close();this.live.delete(sessionId)}
    const modelState=findQuickModel(options.model)
    let threadId:string=randomUUID();let text='';let outboundMessages=options.messages;const dormant=options.purpose?undefined:this.threads.get(sessionId)
    if(dormant&&this.compatible(dormant,options,modelState.id,effort,catalog?.fingerprint)){
     const latest=options.messages.slice(dormant.covered).filter((m)=>m.role==='user').at(-1);if(latest&&messageText(latest).trim()){threadId=dormant.threadId;text=this.decisionAnswer(latest)??messageText(latest);outboundMessages=[latest]}
    }
    if(!text)text=renderTranscript(options.messages)
    if(!options.messages.some((message)=>messageText(message).trim()))throw new LlmError('AWS Quick received an empty prompt.','INVALID_REQUEST')
    const open=this.options.openConnection??QuickConnection.open
    const images=await resolveRequestImages({...options,messages:outboundMessages},this.options.attachments,signal);const attachments=quickImageAttachments(outboundMessages,images)
    const connection=await open({outpost:this.options.outpost,threadId,outpostId:catalog?.outpostId,preApprovedTools:tools.map((tool)=>'dsh_quick__'+tool.name),signal,activity})
    connection.setApprovalResolver?.(this.approvalResolver(catalog))
    turn={connection,catalog,pending:new Map(),state:{threadId,covered:0,fingerprint:'',model:modelState.id,...(effort?{effort}:{}),...(catalog?{toolFingerprint:catalog.fingerprint}:{})}}
    // Budget the whole message against Quick's per-message size limit before
    // sending: a large preset system prompt pasted into `custom_prompt` used to
    // push a short user message over 64 KB and Quick rejected it outright (issue
    // #126). The latest input and the tool/client policy are kept ahead of the
    // trimmable system context.
    const policy=[QUICK_DSH_CLIENT_POLICY,tools.length>0?QUICK_DSH_TOOL_POLICY:''].filter(Boolean).join('\n\n')
    const plan=budgetQuickRequest({text,systemContext:systemContext(options.messages),policy})
    connection.sendUser(plan.text,modelState.mode,effort,attachments,plan.customPrompt)
   }
   if(!turn)throw new LlmError('AWS Quick failed to initialize its connection.','SERVER')
   const currentTurn=turn
   let open:{index:number;kind:'text'|'reasoning';text:string}|null=null;let index=0;let visibleText=''
   const close=():StreamChunk|undefined=>{if(!open)return undefined;const current=open;open=null;return{type:'block-end',index:current.index,block:current.kind==='text'?{type:'text',text:current.text}:{type:'reasoning',text:current.text}} as StreamChunk}
   const filter=new QuickMarkupFilter()
   const emit=function*(kind:'text'|'reasoning',delta:string):Generator<StreamChunk>{if(!delta)return;const currentOpen=open as {index:number;kind:'text'|'reasoning';text:string}|null;if(currentOpen?.kind!==kind){const closing=close();if(closing)yield closing;open={kind,index:index++,text:''};yield{type:'block-start',index:open.index,blockType:kind} as StreamChunk}open!.text+=delta;if(kind==='text')visibleText+=delta;yield{type:kind==='text'?'text-delta':'reasoning-delta',index:open!.index,text:delta} as StreamChunk}
   const separator=():string=>{const current=open as {kind:'text'|'reasoning';text:string}|null;return current?.kind==='text'&&current.text.trim()?'\n\n':''}
   for await(const event of currentTurn.connection.events()){
    if(event.kind==='tool-call'){
     yield* emit('text',filter.flush());const early=filter.decisions.splice(0);if(early.length)yield* emit('text',separator()+renderDecisionsAsText(early))
     const original=currentTurn.catalog?.resolve(event.call.name)??null
     if(!original){currentTurn.connection.answerTool(event.call,'This tool is not part of the active DSH catalog. Use an available DeepSeek Harness tool or report the missing capability.',true);continue}
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
     let decisions:QuickDecision[]
     if(event.reason!=='cancelled'&&event.text!==undefined){
      // Quick's final text can contain markup omitted from text_delta. Parse that
      // authoritative copy, but emit only the suffix not already streamed to DSH.
      const finalFilter=new QuickMarkupFilter();const finalText=finalFilter.push(event.text)+finalFilter.flush()
      if(finalText.startsWith(visibleText))yield* emit('text',finalText.slice(visibleText.length))
      decisions=finalFilter.decisions.splice(0)
     }else{
      yield* emit('text',filter.flush());decisions=filter.decisions.splice(0)
     }
     if(decisions.length&&event.reason!=='cancelled'){
      if(tools.some((tool)=>tool.name===ASK_TOOL)){
       // Quick ended its turn on a choice card; DSH asks through its own question tool and
       // the answer returns to the same Quick thread as a native <decision_response>.
       const closing=close();if(closing)yield closing
       const id='quick-decision-'+randomUUID();const args=JSON.stringify(decisionsToAskArguments(decisions));const toolIndex=index++
       yield{type:'block-start',index:toolIndex,blockType:'tool-call'} as StreamChunk
       yield{type:'tool-call-delta',index:toolIndex,id,name:ASK_TOOL,argumentsDelta:args} as StreamChunk
       yield{type:'block-end',index:toolIndex,block:{type:'tool-call',id,name:ASK_TOOL,arguments:args}} as StreamChunk
       this.rememberDecision(id,decisions)
       yield{type:'finish',reason:{kind:'tool-calls'}}
       if(options.purpose===undefined){this.threads.set(sessionId,{...currentTurn.state,covered:options.messages.length,fingerprint:fingerprint(options.messages,options.messages.length)});this.live.delete(sessionId)}
       await this.options.settings.update({lastTurnAt:Date.now()})
       return
      }
      yield* emit('text',separator()+renderDecisionsAsText(decisions))
     }
     const closing=close();if(closing)yield closing
     if(event.reason==='cancelled')throw new LlmError('AWS Quick turn was cancelled.','ABORTED')
     yield{type:'finish',reason:{kind:'stop'}}
     if(options.purpose===undefined){this.threads.set(sessionId,{...currentTurn.state,covered:options.messages.length,fingerprint:fingerprint(options.messages,options.messages.length)});this.live.delete(sessionId)}
     await this.options.settings.update({lastTurnAt:Date.now()})
     return
    }
    yield* emit(event.kind,event.kind==='text'?filter.push(event.delta):event.delta)
   }
   throw new LlmError('AWS Quick ended without a terminal event.','INVALID_RESPONSE')
  }finally{
   this.active.delete(activeKey)
   if(turn&&!keepLive){for(const call of turn.pending.values())this.options.toolBridge?.settle(call.id,[{type:'text',text:'The Quick DSH turn closed before the tool result arrived.'}],true);turn.pending.clear();turn.connection.close();if(options.purpose===undefined&&this.live.get(sessionId)===turn)this.live.delete(sessionId)}
  }
 }
 async dispose():Promise<void>{for(const turn of this.live.values())turn.connection.close();this.live.clear();this.threads.clear();await this.options.toolBridge?.dispose();await this.options.outpost.dispose()}
}
