// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {act,createElement} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {AwsQuickSection} from '../../../src/client/providers/aws-quick/AwsQuickSection.tsx'
import {QUICK_MODELS} from '../../../src/host/providers/aws-quick/types.ts'
const STATUS={enabled:true,agent:{kind:'installed',path:'/quick/agent',version:'1.2.3'},auth:{authenticated:true,accountName:'Example',email:'user@example.com'},models:QUICK_MODELS,enabledModelIds:null,accountProvider:'social',region:null,defaultMode:'balanced',defaultReasoningEffort:null,login:{state:'idle'}}
describe('AwsQuickSection',()=>{
 let container:HTMLDivElement;let root:Root
 beforeEach(()=>{container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);vi.stubGlobal('fetch',vi.fn(async()=>Response.json({ok:true,value:STATUS})))})
 afterEach(()=>{act(()=>root.unmount());container.remove();vi.unstubAllGlobals();vi.restoreAllMocks()})
 it('renders three official response modes with shared checklist and no account pool or quota',async()=>{
  await act(async()=>root.render(createElement(AwsQuickSection,{})))
  expect(container.querySelectorAll('.dsh-mcl-option')).toHaveLength(3)
  expect(container.querySelector('.dsha-accounts-list')).toBeNull()
  expect(container.textContent).not.toMatch(/d+s*%/)
  expect(container.textContent).toContain('Quick Smart')
 })
 it('guides a first-time user to the official download without requiring an AWS account',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({ok:true,value:{...STATUS,agent:{kind:'missing'},auth:{authenticated:false},tools:{state:'not_initialized'}}})));const open=vi.spyOn(window,'open').mockImplementation(()=>null)
  await act(async()=>root.render(createElement(AwsQuickSection,{})))
  const download=[...container.querySelectorAll('button')].find(button=>button.textContent==='下载 Quick Desktop');expect(download).toBeDefined()
  await act(async()=>download!.click());expect(open).toHaveBeenCalledWith('https://aws.amazon.com/quick/download/','_blank','noopener,noreferrer')
  expect(container.textContent).toContain('无需 AWS 账户');expect(container.textContent).toContain('初始化 DSH 工具')
  const prepare=[...container.querySelectorAll('button')].find(button=>button.textContent==='初始化 DSH 工具');expect(prepare?.disabled).toBe(true)
 })
 it('shows native connector approval and initializes tools through the same-origin route',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>Response.json({ok:true,value:init?.method==='POST'?{...STATUS,tools:{state:'ready'}}:{...STATUS,tools:{state:'approval_required'}}})))
  await act(async()=>root.render(createElement(AwsQuickSection,{})))
  expect(container.textContent).toContain('请在 Quick → 自定义 → 连接器中启用 DeepSeek Harness')
  const prepare=[...container.querySelectorAll('button')].find(button=>button.textContent==='初始化 DSH 工具');expect(prepare?.disabled).toBe(false)
  await act(async()=>prepare!.click());expect(vi.mocked(fetch).mock.calls.some(([input,init])=>String(input).endsWith('/aws-quick/api/tools/prepare')&&init?.method==='POST')).toBe(true)
  expect(container.textContent).toContain('DeepSeek Harness 已就绪')
 })
 it('does not claim signed-out or missing-agent diagnostics while disabled',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({ok:true,value:{...STATUS,enabled:false,agent:{kind:'missing'},auth:{authenticated:false},models:[]}})))
  await act(async()=>root.render(createElement(AwsQuickSection,{})))
  expect(container.textContent).toContain('线路已停用，未查询登录状态')
  expect(container.textContent).not.toContain('未登录')
  expect(container.textContent).not.toContain('未找到 AWS Quick agent')
 })
})
