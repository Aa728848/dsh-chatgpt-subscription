import {describe,expect,it} from 'vitest'
import {installSessionTitleGuard,type SessionTitleChunk,type SessionTitleStreamListener} from '../../src/host/runtime/session-title-guard/index.ts'

// Capture the listener a context hands to `on('llm/stream', ...)`.
function capture(deps:{providers:readonly string[];enabled?:()=>boolean}){
 const listeners:SessionTitleStreamListener[]=[]
 const ctx={on:(event:string,listener:SessionTitleStreamListener)=>{expect(event).toBe('llm/stream');listeners.push(listener);return ()=>undefined}}
 const handle=installSessionTitleGuard(ctx,deps)
 return {handle,listener:listeners[0]!}
}
// A `next` that records it was reached and yields one sentinel adapter chunk.
function next(){
 const state={called:false}
 const fn=()=>{state.called=true;return (async function*(){yield {type:'adapter-chunk'} as SessionTitleChunk})()}
 return {state,fn}
}
async function drain(stream:AsyncIterable<SessionTitleChunk>){const out:SessionTitleChunk[]=[];for await(const c of stream)out.push(c);return out}

describe('session title guard',()=>{
 it('short-circuits the auxiliary title request on a scoped provider without dispatching the adapter',async()=>{
  const {listener}=capture({providers:['aws-quick','kimi-code']})
  const n=next()
  const chunks=await drain(listener({provider:'aws-quick',purpose:'session-title'},n.fn))
  expect(n.state.called).toBe(false)
  expect(chunks).toEqual([{type:'finish',reason:{kind:'stop'}}])
 })
 it('passes an ordinary conversation turn straight through',async()=>{
  const {listener}=capture({providers:['aws-quick']})
  const n=next()
  const chunks=await drain(listener({provider:'aws-quick'},n.fn))
  expect(n.state.called).toBe(true)
  expect(chunks).toEqual([{type:'adapter-chunk'}])
 })
 it('leaves a title request on an unscoped provider untouched',async()=>{
  const {listener}=capture({providers:['aws-quick']})
  const n=next()
  const chunks=await drain(listener({provider:'deepseek-official',purpose:'session-title'},n.fn))
  expect(n.state.called).toBe(true)
  expect(chunks).toEqual([{type:'adapter-chunk'}])
 })
 it('honours the live switch: disabled means the title request is sent',async()=>{
  const {listener}=capture({providers:['aws-quick'],enabled:()=>false})
  const n=next()
  const chunks=await drain(listener({provider:'aws-quick',purpose:'session-title'},n.fn))
  expect(n.state.called).toBe(true)
  expect(chunks).toEqual([{type:'adapter-chunk'}])
 })
 it('treats a missing provider as unscoped rather than skipping it',async()=>{
  const {listener}=capture({providers:['aws-quick']})
  const n=next()
  await drain(listener({purpose:'session-title'},n.fn))
  expect(n.state.called).toBe(true)
 })
 it('returns undefined on a host without an event bus',()=>{
  const handle=installSessionTitleGuard({}, {providers:['aws-quick']})
  expect(handle).toBeUndefined()
 })
})
