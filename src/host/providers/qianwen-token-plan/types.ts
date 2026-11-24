/** Host-only constants for the Qwen Token Plan line. */
import {
  QIANWEN_TOKEN_PLAN_PROVIDER_ID,
  QIANWEN_TOKEN_PLAN_PROVIDER_NAME,
} from '../../../shared/qianwen-token-plan-contracts.ts'

export const PROVIDER_ID = QIANWEN_TOKEN_PLAN_PROVIDER_ID
export const PROVIDER_NAME = QIANWEN_TOKEN_PLAN_PROVIDER_NAME

/** Official DSH guide: https://platform.qianwenai.com/docs/developer-guides/clients-and-developer-tools/deepseek-harness */
export const QIANWEN_TOKEN_PLAN_BASE_URL = 'https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1'
export const QIANWEN_CHAT_COMPLETIONS_URL = QIANWEN_TOKEN_PLAN_BASE_URL + '/chat/completions'
export const QIANWEN_MODELS_URL = QIANWEN_TOKEN_PLAN_BASE_URL + '/models'
export const QIANWEN_RESPONSES_URL = QIANWEN_TOKEN_PLAN_BASE_URL + '/responses'

export const QIANWEN_USER_AGENT = 'dsh-chatgpt-subscription (+https://github.com/Aa728848/dsh-chatgpt-subscription)'
export const QIANWEN_MIN_PIXELS = 65_536
export const QIANWEN_MAX_PIXELS = 16_777_216
export const QIANWEN_DEFAULT_MAX_PIXELS = 2_621_440

export function qianwenHeaders(apiKey: string): Record<string, string> {
  return {
    authorization: 'Bearer ' + apiKey,
    'content-type': 'application/json',
    'user-agent': QIANWEN_USER_AGENT,
  }
}
