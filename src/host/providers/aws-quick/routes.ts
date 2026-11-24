import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isSameOriginMutation } from '../../common/same-origin.ts'
import { AWS_QUICK_EFFORTS, AWS_QUICK_MODES, AWS_QUICK_ROUTE_PREFIX, type AwsQuickSettingsUpdateDto, type AwsQuickStatusDto } from '../../../shared/aws-quick-contracts.ts'
import type { AwsQuickSettingsStore } from './settings.ts'
import type { AwsQuickOutpost } from './outpost.ts'
import type { AwsQuickToolBridge } from './tool-bridge.ts'
import { resolveQuickAgent } from './binary.ts'
import { QUICK_MODELS } from './types.ts'

interface RouteOptions { settings:AwsQuickSettingsStore;outpost:AwsQuickOutpost;tools?:AwsQuickToolBridge;conflict():string|null }
async function bodyJson(request:IncomingMessage):Promise<Record<string,unknown>> {
  const chunks:Buffer[]=[];let size=0
  for await (const chunk of request){const b=Buffer.from(chunk);size+=b.length;if(size>64*1024)throw new Error('Request body too large.');chunks.push(b)}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}') as Record<string,unknown>
}
function json(response:ServerResponse,status:number,value:unknown):void { response.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});response.end(JSON.stringify(value)) }
function allowedUpdate(body:Record<string,unknown>):AwsQuickSettingsUpdateDto|undefined {
  const out:AwsQuickSettingsUpdateDto={}
  if(body.enabled!==undefined){if(typeof body.enabled!=='boolean')return;out.enabled=body.enabled}
  if(body.enabledModelIds!==undefined){if(body.enabledModelIds===null)out.enabledModelIds=null;else if(Array.isArray(body.enabledModelIds)&&body.enabledModelIds.every((x)=>typeof x==='string'))out.enabledModelIds=body.enabledModelIds;else return}
  if(body.binaryPath!==undefined){if(body.binaryPath!==null&&typeof body.binaryPath!=='string')return;out.binaryPath=body.binaryPath}
  if(body.accountProvider!==undefined){if(body.accountProvider!=='social'&&body.accountProvider!=='enterprise')return;out.accountProvider=body.accountProvider}
  if(body.region!==undefined){if(body.region!==null&&(typeof body.region!=='string'||!/^[a-z0-9-]{2,64}$/i.test(body.region)))return;out.region=body.region}
  if(body.defaultMode!==undefined){if(!AWS_QUICK_MODES.includes(body.defaultMode as never))return;out.defaultMode=body.defaultMode as never}
  if(body.defaultReasoningEffort!==undefined){if(body.defaultReasoningEffort!==null&&!AWS_QUICK_EFFORTS.includes(body.defaultReasoningEffort as never))return;out.defaultReasoningEffort=body.defaultReasoningEffort as never}
  return out
}
export async function readAwsQuickStatus(options:RouteOptions,force=false):Promise<AwsQuickStatusDto> {
  const settings=await options.settings.read()
  const agent=await resolveQuickAgent(settings.binaryPath)
  const auth=settings.enabled&&agent.path?await options.outpost.auth(force):{authenticated:false}
  const conflict=options.conflict()
  return {
    enabled:settings.enabled,agent,auth,models:settings.enabled?QUICK_MODELS:[],enabledModelIds:settings.enabledModelIds,
    accountProvider:settings.accountProvider,region:settings.region,defaultMode:settings.defaultMode,defaultReasoningEffort:settings.defaultReasoningEffort,
    login:options.outpost.loginStatus(),...(options.tools?{tools:options.tools.status()}:{}),...(conflict?{routeConflict:conflict}:{}),
  }
}
export function registerAwsQuickRoutes(ctx:Context,options:RouteOptions):()=>void {
  return ctx.webServer.register({kind:'prefix',path:AWS_QUICK_ROUTE_PREFIX,handler:async(request:IncomingMessage,response:ServerResponse)=>{
    const url=new URL(request.url||'/','http://dsh.local')
    const path=url.pathname.replace(/^\/aws-quick\/api\/?/,'')
    const method=request.method??'GET'
    try{
      if(path===''||path==='status'||path==='settings'||path==='models'){
        if(method==='GET')return json(response,200,{ok:true,value:await readAwsQuickStatus(options)})
        if(method!=='POST')return json(response,405,{ok:false,error:'Method not allowed.'})
        if(!isSameOriginMutation(request))return json(response,403,{ok:false,error:'Cross-origin request rejected.'})
        const update=allowedUpdate(await bodyJson(request));if(!update)return json(response,400,{ok:false,error:'Unsupported settings value.'})
        await options.settings.update(update);ctx.emit?.('llm/adapters-updated')
        return json(response,200,{ok:true,value:await readAwsQuickStatus(options,true)})
      }
      if(path==='tools/prepare'){
        if(method!=='POST')return json(response,405,{ok:false,error:'Method not allowed.'})
        if(!isSameOriginMutation(request))return json(response,403,{ok:false,error:'Cross-origin request rejected.'})
        if(!options.tools)return json(response,503,{ok:false,error:'Quick tool bridge is unavailable.'})
        await options.tools.prepare()
        return json(response,200,{ok:true,value:await readAwsQuickStatus(options,true)})
      }
      if(path==='login/start'){
        if(method!=='POST')return json(response,405,{ok:false,error:'Method not allowed.'})
        if(!isSameOriginMutation(request))return json(response,403,{ok:false,error:'Cross-origin request rejected.'})
        const value=await options.outpost.login()
        return json(response,value.state==='error'?400:200,value.state==='error'?{ok:false,error:value.error}:{ok:true,value})
      }
      if(path==='login/cancel'||path==='logout'||path==='refresh'){
        if(method!=='POST')return json(response,405,{ok:false,error:'Method not allowed.'})
        if(!isSameOriginMutation(request))return json(response,403,{ok:false,error:'Cross-origin request rejected.'})
        if(path==='login/cancel')await options.outpost.cancelLogin()
        else if(path==='logout')await options.outpost.logout()
        return json(response,200,{ok:true,value:await readAwsQuickStatus(options,true)})
      }
      if(path==='login/status')return json(response,200,{ok:true,value:await readAwsQuickStatus(options,true)})
      return json(response,404,{ok:false,error:'Not found.'})
    }catch(error){return json(response,500,{ok:false,error:error instanceof Error?error.message:String(error)})}
  }})
}
