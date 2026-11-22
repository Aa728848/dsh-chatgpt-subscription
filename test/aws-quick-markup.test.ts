import {describe,expect,it} from 'vitest'
import {decisionResponseText,decisionsToAskArguments,parseQuickDecision,QuickMarkupFilter,renderDecisionsAsText} from '../src/host/aws-quick/markup.ts'
import {quickApprovalDecision,quickPermissionReply,readQuickPermissionRequest} from '../src/host/aws-quick/protocol.ts'

const DECISION='<decision question="下一步怎么做?"><option description="只提交 lint 修复">提交并推送</option><option description="保持本地">只提交，不推送</option></decision>'

describe('Quick UI markup filter',()=>{
 it('lifts a decision split across deltas out of the visible text and drops sources',()=>{
  const filter=new QuickMarkupFilter();const source='验证通过。\n'+DECISION+'\n<sources>[偏好](mem://abc)</sources>'
  let visible='';for(let i=0;i<source.length;i+=7)visible+=filter.push(source.slice(i,i+7));visible+=filter.flush()
  expect(visible).toBe('验证通过。\n\n');expect(filter.decisions).toEqual([{question:'下一步怎么做?',multi:false,options:[{label:'提交并推送',description:'只提交 lint 修复'},{label:'只提交，不推送',description:'保持本地'}]}])
 })
 it('reads grouped decisions, multi-select and escaped attributes',()=>{
  const filter=new QuickMarkupFilter()
  const visible=filter.push('<decisions><decision question="A &amp; B?" multi="true"><option>x</option><option>y</option></decision><decision question="C?"><option>z</option></decision></decisions>done')+filter.flush()
  expect(visible).toBe('done');expect(filter.decisions.map((d)=>[d.question,d.multi,d.options.length])).toEqual([['A & B?',true,2],['C?',false,1]])
 })
 it('holds only a possible tag prefix and releases ordinary angle brackets and unterminated blocks',()=>{
  const filter=new QuickMarkupFilter()
  expect(filter.push('a < b and <dec')).toBe('a < b and ');expect(filter.push('k>')).toBe('<deck>')
  expect(filter.push('<decision question="q">open')).toBe('');expect(filter.flush()).toBe('<decision question="q">open');expect(filter.decisions).toEqual([])
 })
 it('projects decisions onto ask_user_question and answers in Quick native form',()=>{
  const decision=parseQuickDecision(DECISION)!
  expect(decisionsToAskArguments([decision])).toEqual({questions:[{id:'q1',question:'下一步怎么做?',options:[{label:'提交并推送',description:'只提交 lint 修复'},{label:'只提交，不推送',description:'保持本地'}]}]})
  expect(decisionResponseText([decision],JSON.stringify({answers:[{id:'q1',selected:['提交并推送'],custom:'顺便跑 CI'}]}))).toBe('<decision_response>下一步怎么做?: 提交并推送, 顺便跑 CI</decision_response>')
  expect(decisionResponseText([decision],'skipped')).toBe('<decision_response>下一步怎么做?: skipped</decision_response>')
  expect(renderDecisionsAsText([decision])).toBe('**下一步怎么做?**\n1. 提交并推送 — 只提交 lint 修复\n2. 只提交，不推送 — 保持本地')
 })
})

describe('Quick approval replies',()=>{
 it('answers a connector permission request with the official tool_approval or permission_denied shape',()=>{
  const request=readQuickPermissionRequest({type:'permission_request',connector_id:'user_mcp',action_id:'dsh_quick__win_bash',tool_name:'dsh_quick__win_bash',params_hash:'h1',request_body:{command:'git status'},call_tool_use_id:'tu-1',conversation_id:'c-1'},'thread-1')
  expect(quickPermissionReply(request,true)).toEqual({type:'tool_approval',connectorId:'user_mcp',actionId:'dsh_quick__win_bash',sessionId:'thread-1',params:'{"command":"git status"}',paramsHash:'h1',conversationId:'c-1',toolUseId:'tu-1',scope:'ALLOW_ONCE'})
  expect(quickPermissionReply(request,false)).toMatchObject({type:'permission_denied',connectorId:'user_mcp',actionId:'dsh_quick__win_bash',paramsHash:'h1'})
  expect(quickPermissionReply(request,false)).not.toHaveProperty('scope')
 })
 it('answers a generic approval request and ignores one without an id',()=>{
  expect(quickApprovalDecision({approval_id:'a-1',tool_name:'run_python'},'thread-1',false)).toEqual({type:'approval_decision',payload:{approval_id:'a-1',decision:'denied',session_id:'thread-1'}})
  expect(quickApprovalDecision({approval_id:'a-2',session_id:'s-2'},'thread-1',true)).toEqual({type:'approval_decision',payload:{approval_id:'a-2',decision:'approved_once',session_id:'s-2'}})
  expect(quickApprovalDecision({},'thread-1',true)).toBeNull()
 })
})
