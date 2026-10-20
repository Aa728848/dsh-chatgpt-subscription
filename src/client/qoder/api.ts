import { QODER_PROVIDER_NAME, QODER_ROUTE_PREFIX } from '../../shared/qoder-contracts.ts'
import { createLineApi } from '../common/line-api.ts'

/**
 * 本线路的 host 路由由这一个文件描述，卡片与输入框胶囊都从这里取。
 *
 * **路由表是与 host 侧 routes.ts 的约定**（两边逐条对上，错一条就是运行时的 404）：
 *
 *   GET  /status                 → QoderStatusDto（页面的唯一读口）
 *   POST /settings               QoderSettingsUpdateDto → QoderStatusDto
 *                                 （总开关、模型勾选、上下文窗口覆盖、默认档位、手选账号）
 *   POST /accounts               { action, accountId } / { action:'strategy', strategy } → QoderStatusDto
 *   POST /login/start            { region } → QoderLoginFlowStatus（浏览器设备流，仅全球区）
 *   GET  /login/status           → QoderLoginFlowStatus（设备流不开本地回调端口，卡片只跟随 host）
 *   POST /login/cancel           { } → QoderLoginFlowStatus
 *   POST /login/manual           { region, token } → QoderStatusDto（手动粘贴 PAT；
 *                                 请求体必然带凭据，刻意不在冻结契约里声明）
 *   POST /adopt                  { } → QoderAdoptResultDto（**裸 DTO，不走信封**；失败永不阻断）
 *   POST /connection/test        → QoderConnectionDto（**裸 DTO，不走信封**）
 *   POST /quota                  { } → QoderStatusDto（强制刷新额度）
 *   POST /catalog/refresh        { } → QoderStatusDto
 *
 * 除 /adopt 与 /connection/test 外全部走共享的 { ok, value } 信封，
 * 因此答案都是裸 DTO——createLineApi 已经把信封拆掉了。
 *
 * 凭据边界也写在这里：/login/manual 的请求体是本文件里**唯一**带秘密的形状，
 * 它只在这个函数调用点的字面量里出现，既不进 URL、也不进日志。
 */
const api = createLineApi(QODER_ROUTE_PREFIX, QODER_PROVIDER_NAME)

export const get = api.get
export const post = api.post

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
