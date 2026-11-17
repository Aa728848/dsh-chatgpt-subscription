import type { QianwenModelOption, QianwenReasoningEffort } from '../../shared/qianwen-token-plan-contracts.ts'
import { QIANWEN_REASONING_EFFORTS } from '../../shared/qianwen-token-plan-contracts.ts'

export type QianwenPlanAvailability = 'personal-and-team' | 'team-only'
export interface QianwenModelEntry {
  id: string
  name: string
  availability: QianwenPlanAvailability
  automaticRouting: boolean
  defaultContextWindow: number
  defaultMaxTokens: number
  maxOutputTokens: number
  reasoningEfforts: readonly QianwenReasoningEffort[]
  thinkingDisableable: boolean
  supportsImages: boolean
  supportsVideo: boolean
  supportsExplicitCache: boolean
  supportsCoTSummary: boolean
  supportsVisualBudget: boolean
  description: string | null
}
type Input = Pick<QianwenModelEntry,'id'|'name'|'defaultContextWindow'|'defaultMaxTokens'|'maxOutputTokens'> & Partial<QianwenModelEntry>
function model(input: Input): QianwenModelEntry {
  return {
    availability:'personal-and-team',automaticRouting:false,reasoningEfforts:[],thinkingDisableable:false,
    supportsImages:false,supportsVideo:false,supportsExplicitCache:false,supportsCoTSummary:false,
    supportsVisualBudget:false,description:null,...input,
  }
}
const visualQwen = {
  thinkingDisableable:true,supportsImages:true,supportsVideo:true,supportsVisualBudget:true,
} as const

export const QIANWEN_MODEL_CATALOG: readonly QianwenModelEntry[] = [
  model({id:'auto',name:'Auto（套餐动态路由）',automaticRouting:true,defaultContextWindow:256_000,defaultMaxTokens:32_768,maxOutputTokens:32_768,description:'动态选择上游模型；窗口与输出是本机保守预算，不是固定上游能力。'}),
  model({id:'qwen4-max',name:'Qwen4 Max',defaultContextWindow:1_000_000,defaultMaxTokens:262_144,maxOutputTokens:262_144,reasoningEfforts:QIANWEN_REASONING_EFFORTS,...visualQwen,supportsExplicitCache:true,supportsCoTSummary:true}),
  model({id:'qwen4-max-preview',name:'Qwen4 Max Preview',defaultContextWindow:1_000_000,defaultMaxTokens:131_072,maxOutputTokens:131_072,reasoningEfforts:QIANWEN_REASONING_EFFORTS,...visualQwen,supportsExplicitCache:true,description:'上游限时预览；输出采用官方 DSH 指南的保守值。'}),
  model({id:'qwen4.0-max-preview',name:'Qwen4.0 Max Preview（别名）',defaultContextWindow:1_000_000,defaultMaxTokens:131_072,maxOutputTokens:131_072,reasoningEfforts:QIANWEN_REASONING_EFFORTS,...visualQwen,supportsExplicitCache:true}),
  model({id:'qwen3.8-max',name:'Qwen3.8 Max',defaultContextWindow:1_000_000,defaultMaxTokens:131_072,maxOutputTokens:131_072,reasoningEfforts:QIANWEN_REASONING_EFFORTS,...visualQwen}),
  model({id:'qwen3.8-flash',name:'Qwen3.8 Flash',defaultContextWindow:1_000_000,defaultMaxTokens:131_072,maxOutputTokens:131_072,reasoningEfforts:QIANWEN_REASONING_EFFORTS,...visualQwen}),
  model({id:'qwen3.7-max',name:'Qwen3.7 Max',defaultContextWindow:1_000_000,defaultMaxTokens:65_536,maxOutputTokens:65_536,thinkingDisableable:true,description:'Token Plan 清单声明文本生成；不套用快照版的视觉能力。'}),
  model({id:'qwen3.7-plus',name:'Qwen3.7 Plus',defaultContextWindow:1_000_000,defaultMaxTokens:65_536,maxOutputTokens:65_536,...visualQwen}),
  model({id:'qwen3.6-plus',name:'Qwen3.6 Plus',availability:'team-only',defaultContextWindow:1_000_000,defaultMaxTokens:65_536,maxOutputTokens:65_536,...visualQwen}),
  model({id:'qwen3.6-flash',name:'Qwen3.6 Flash',defaultContextWindow:1_000_000,defaultMaxTokens:65_536,maxOutputTokens:65_536,...visualQwen}),
  model({id:'deepseek-v4.1-flash',name:'DeepSeek V4.1 Flash',defaultContextWindow:1_000_000,defaultMaxTokens:393_216,maxOutputTokens:393_216,thinkingDisableable:true,supportsImages:true}),
  model({id:'deepseek-v4.1-flash-1017',name:'DeepSeek V4.1 Flash 1017',defaultContextWindow:1_000_000,defaultMaxTokens:393_216,maxOutputTokens:393_216,thinkingDisableable:true,supportsImages:true}),
  model({id:'deepseek-v4-pro',name:'DeepSeek V4 Pro',defaultContextWindow:1_000_000,defaultMaxTokens:393_216,maxOutputTokens:393_216,thinkingDisableable:true}),
  model({id:'deepseek-v4-pro-0813',name:'DeepSeek V4 Pro 0813',defaultContextWindow:1_000_000,defaultMaxTokens:393_216,maxOutputTokens:393_216,thinkingDisableable:true}),
  model({id:'deepseek-v4-flash-0731',name:'DeepSeek V4 Flash 0731',defaultContextWindow:1_000_000,defaultMaxTokens:393_216,maxOutputTokens:393_216,thinkingDisableable:true}),
  model({id:'glm-5.3',name:'GLM 5.3',defaultContextWindow:1_000_000,defaultMaxTokens:131_072,maxOutputTokens:131_072}),
  model({id:'glm-5.2',name:'GLM 5.2',defaultContextWindow:198_000,defaultMaxTokens:131_072,maxOutputTokens:131_072,thinkingDisableable:true}),
  model({id:'glm-5.1',name:'GLM 5.1',availability:'team-only',defaultContextWindow:198_000,defaultMaxTokens:131_072,maxOutputTokens:131_072,thinkingDisableable:true}),
  model({id:'glm-5',name:'GLM 5',availability:'team-only',defaultContextWindow:198_000,defaultMaxTokens:131_072,maxOutputTokens:131_072}),
  model({id:'kimi-k2.7-code',name:'Kimi K2.7 Code',availability:'team-only',defaultContextWindow:256_000,defaultMaxTokens:32_768,maxOutputTokens:32_768,supportsImages:true}),
  model({id:'kimi-k2.6',name:'Kimi K2.6',availability:'team-only',defaultContextWindow:256_000,defaultMaxTokens:32_768,maxOutputTokens:32_768,thinkingDisableable:true,supportsImages:true}),
  model({id:'kimi-k2.5',name:'Kimi K2.5',availability:'team-only',defaultContextWindow:256_000,defaultMaxTokens:32_768,maxOutputTokens:32_768,thinkingDisableable:true,supportsImages:true}),
  model({id:'MiniMax-M2.5',name:'MiniMax M2.5',availability:'team-only',defaultContextWindow:200_000,defaultMaxTokens:32_768,maxOutputTokens:32_768}),
]
export const DEFAULT_VISIBLE_MODEL_IDS: readonly string[] = QIANWEN_MODEL_CATALOG.map(item=>item.id)
export function resolveQianwenModel(id:string):QianwenModelEntry{
  const wanted=id.trim()
  return QIANWEN_MODEL_CATALOG.find(item=>item.id===wanted) ?? model({id:wanted,name:wanted||'未声明模型',defaultContextWindow:256_000,defaultMaxTokens:32_768,maxOutputTokens:32_768})
}
const capacity=(value:number)=>value>=1_000_000?(value/1_000_000)+'M':Math.round(value/1000)+'K'
export function describeQianwenModel(item:QianwenModelEntry):string{
  const plan=item.availability==='team-only'?'团队版':'个人+团队'
  const reasoning=item.automaticRouting?'动态路由':item.reasoningEfforts.length>0?'七档直选':'上游默认思考'
  const modality=item.supportsVideo?'图文视频':item.supportsImages?'图像':'文本'
  return [plan,reasoning,modality,capacity(item.defaultContextWindow),item.supportsExplicitCache?'缓存5m/1h':'',item.supportsCoTSummary?'CoT回放':''].filter(Boolean).join('｜')
}
export function catalogModelOptions(settings:{enabledModelIds?:readonly string[]|null;contextWindowOverrides?:Readonly<Record<string,number>>}={}):QianwenModelOption[]{
  const selected=settings.enabledModelIds ?? DEFAULT_VISIBLE_MODEL_IDS
  return QIANWEN_MODEL_CATALOG.map(item=>({...item,hint:describeQianwenModel(item),enabled:selected.includes(item.id),contextWindow:settings.contextWindowOverrides?.[item.id]??item.defaultContextWindow}))
}
