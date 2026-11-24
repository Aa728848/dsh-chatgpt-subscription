import { STEP_CODE_PROVIDER_NAME, STEP_CODE_ROUTE_PREFIX } from '../../../shared/step-code-contracts.ts'
import { createLineApi } from '../../common/line-api.ts'

/**
 * 本线路的 host 路由由这一个文件描述，卡片与输入框胶囊都从这里取。
 */
const api = createLineApi(STEP_CODE_ROUTE_PREFIX, STEP_CODE_PROVIDER_NAME)

export const get = api.get
export const post = api.post

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
