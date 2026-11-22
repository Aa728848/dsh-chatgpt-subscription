import {describe,expect,it} from 'vitest'
import {EventStreamCodec} from '@smithy/eventstream-codec'
import {decodeQuickOutput,encodeQuickInput,isQuickChatHost,quickStopGeneration,quickUserMessage,unwrapQuickToolArguments,QUICK_DESKTOP_SURFACE} from '../src/host/aws-quick/protocol.ts'
const encoder=new TextEncoder();const decoder=new TextDecoder()
const codec=new EventStreamCodec((value)=>decoder.decode(value),(value)=>encoder.encode(value))
function frame(value:unknown):Uint8Array{
 const inner=JSON.stringify(value)
 const body=encoder.encode(JSON.stringify({payload:Buffer.from(inner,'utf8').toString('base64')}))
 return codec.encode({headers:{':message-type':{type:'string',value:'event'},':event-type':{type:'string',value:'rawOutputEvent'}},body})
}
describe('AWS Quick AIDP wire protocol',()=>{
 it('wraps user JSON as UTF-8 binary rawInputEvent with base64 payload',()=>{
  const value=quickUserMessage({text:'你好',threadId:'thread',messageId:'message',traceId:'trace',mode:'smart',effort:'high'})
  const outer=JSON.parse(decoder.decode(encodeQuickInput(value))) as {eventType:string;payload:{payload:string}}
  expect(outer.eventType).toBe('rawInputEvent')
  expect(JSON.parse(Buffer.from(outer.payload.payload,'base64').toString('utf8'))).toEqual(value)
  expect(value).toMatchObject({type:'user_message',payload:{text:'你好',thread_id:'thread',message_id:'message',agent_mode:'smart',thinking_effort:'high',web_search_enabled:false}})
 })
 it('binds every user message to the official desktop outpost session',()=>{
  const value=quickUserMessage({text:'run',threadId:'thread',mode:'balanced',invokingOutpostId:'outpost-1',appVersion:'1.2.4660',customPrompt:'Use DSH tools'})
  expect(value).toMatchObject({type:'user_message',payload:{outpostId:'outpost-1',invokingOutpostId:'outpost-1',surfaceType:QUICK_DESKTOP_SURFACE,appVersion:'1.2.4660',custom_prompt:'Use DSH tools',self_registering_connectors:1,external_agent_sign_in:1,recents_promotion:1}})
 })
 it('serializes admitted image attachments without dropping their bytes',()=>{
  const attachments=[{type:'image' as const,name:'pixel.png',size:4,mimeType:'image/png',data:'data:image/png;base64,AQIDBA=='}]
  const value=quickUserMessage({text:'describe',threadId:'thread',mode:'balanced',attachments})
  expect(value).toMatchObject({payload:{attachments}})
 })
 it('unwraps Quick relay params without leaking transport metadata to DSH',()=>{
  const wrapped={params:{name:'dsh_quick__read',arguments:{path:'a.ts'},_quickwork:{result_transport_token:'secret'}}}
  expect(unwrapQuickToolArguments(wrapped)).toBe('{"path":"a.ts"}')
  expect(unwrapQuickToolArguments({arguments:{message:'ok'},_quickwork:{trace_id:'trace'}})).toBe('{"message":"ok"}')
 })
 it('round-trips event-stream rawOutputEvent and unicode text',()=>{
  expect(decodeQuickOutput(frame({type:'text_delta',thread_id:'t',payload:{delta:'你好 🚀'}}))).toEqual({type:'text_delta',thread_id:'t',payload:{delta:'你好 🚀'}})
 })
 it('surfaces event-stream exception headers',()=>{
  const data=codec.encode({headers:{':message-type':{type:'string',value:'exception'},':exception-type':{type:'string',value:'AccessDenied'},':error-message':{type:'string',value:'denied'}},body:new Uint8Array()})
  expect(()=>decodeQuickOutput(data)).toThrow(/AccessDenied.*denied/)
 })
 it('creates a targeted stop frame and validates tenant hosts',()=>{
  expect(quickStopGeneration('t','assistant')).toEqual({type:'stop_generation',payload:{message_id:'assistant',thread_id:'t'}})
  expect(isQuickChatHost('cell.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev')).toBe(true)
  expect(isQuickChatHost('tenant.enterprise.quick.aws.com')).toBe(true)
  expect(isQuickChatHost('example.com')).toBe(false)
  expect(isQuickChatHost('evil.plato.ai.aws.dev:443')).toBe(false)
 })
})
