import { RELAYONE_PROVIDER_NAME, RELAYONE_ROUTE_PREFIX } from '../../shared/relayone-contracts.ts'
import { createLineApi } from '../common/line-api.ts'
const api = createLineApi(RELAYONE_ROUTE_PREFIX, RELAYONE_PROVIDER_NAME)
export const get = api.get
export const post = api.post
export const request = api.request
export const messageOf = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause)
