import {describe,expect,it,vi} from 'vitest'
import type {AwsQuickOutpost} from '../../../src/host/providers/aws-quick/outpost.ts'
import type {QuickStreamEvent} from '../../../src/host/providers/aws-quick/client.ts'
const {sockets}=vi.hoisted(()=>({sockets:[] as Array<{readyState:number;onopen?:()=>void;onmessage?:(event:{data:string})=>void;emit(value:unknown):void}>}))
vi.mock('undici',()=>({WebSocket:class{
 static readonly CONNECTING=0;static readonly OPEN=1
 readyState=0;onopen?:()=>void;onmessage?:(event:{data:string})=>void;onerror?:()=>void;onclose?:()=>void;binaryType=''
 constructor(){sockets.push(this);queueMicrotask(()=>{this.readyState=1;this.onopen?.()})}
 send(_data:unknown):void{}
 emit(value:unknown):void{this.onmessage?.({data:JSON.stringify(value)})}
 close():void{this.readyState=3}
}}))
import {QuickConnection} from '../../../src/host/providers/aws-quick/client.ts'
const outpost={session:async()=>({wsHost:'cell.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev',wsPath:'/streaming/quickwork-chat-bidirectional-stream',provider:'social',actorArn:'actor',jwt:'token',surface:'QUICK_WORK_DESKTOP_WINDOWS',appVersion:'1.2.4660'})} as unknown as AwsQuickOutpost
async function flush():Promise<void>{await Promise.resolve();await Promise.resolve()}
describe('AWS Quick connection final text',()=>{
 it('carries text_complete through message_complete even when deltas omit decision markup',async()=>{
  const opening=QuickConnection.open({outpost,threadId:'thread-1'})
  await vi.waitFor(()=>expect(sockets[0]?.readyState).toBe(1));await flush()
  const finalText='接下来怎么做？\n<decision question="继续?"><option>继续</option><option>停止</option></decision>'
  sockets[0].emit({type:'connected',payload:{user:{}}});const connection=await opening
  const received:(Promise<QuickStreamEvent[]>)=(async()=>{const out:QuickStreamEvent[]=[];for await(const event of connection.events())out.push(event);return out})()
  sockets[0].emit({type:'text_delta',payload:{delta:'接下来怎么做？\n'}});await flush()
  sockets[0].emit({type:'text_complete',payload:{text:finalText}});await flush()
  sockets[0].emit({type:'message_complete',payload:{}})
  await expect(received).resolves.toEqual([{kind:'text',delta:'接下来怎么做？\n'},{kind:'done',reason:'stop',text:finalText}])
  connection.close()
 })
})
