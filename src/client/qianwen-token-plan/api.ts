import { QIANWEN_TOKEN_PLAN_PROVIDER_NAME, QIANWEN_TOKEN_PLAN_ROUTE_PREFIX } from '../../shared/qianwen-token-plan-contracts.ts'
import { createLineApi } from '../common/line-api.ts'

const api = createLineApi(QIANWEN_TOKEN_PLAN_ROUTE_PREFIX, QIANWEN_TOKEN_PLAN_PROVIDER_NAME)
export const get = api.get
export const post = api.post
export const request = api.request
export const messageOf = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause)
