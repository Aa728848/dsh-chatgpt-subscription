import { STEP_CODE_PROVIDER_NAME, STEP_CODE_ROUTE_PREFIX } from '../../shared/step-code-contracts.ts'
import { createLineApi } from '../common/line-api.ts'

/**
 * 本线路的 host 路由由这一个文件描述，卡片与输入框胶囊都从这里取。
 *
 * **路由表是与 host 侧 routes.ts 的约定**：下表按计划 §6.1 与兄弟线路的命名习惯定下，
 * 一旦 host 侧拼写不同，只需要改这一个文件。
 *
 *   GET  /status                 → StepCodeStatusDto（页面的唯一读口）
 *   POST /settings               StepCodeSettingsUpdateDto → StepCodeStatusDto
 *                                 （总开关、模型勾选、上下文窗口覆盖、默认档位、手选账号、缓存参数能力位）
 *   POST /accounts               { action, accountId } / { action:'strategy', strategy } → StepCodeStatusDto
 *   POST /login/start            { profile } → StepCodeLoginFlowStatus
 *   GET  /login/status           → StepCodeLoginFlowStatus（云端轮询登录不开本地回调端口，卡片只跟随 host）
 *   POST /login/cancel           { } → StepCodeLoginFlowStatus
 *   POST /login/manual           { profile, apiKey } → StepCodeStatusDto（手工粘贴 Platform API Key；
 *                                 请求体必然带凭据，刻意不在冻结契约里声明）
 *   POST /adopt                  { } → StepCodeAdoptResultDto（**裸 DTO，不走信封**；失败永不阻断，
 *                                 卡片据 reason 给出不同的下一步）
 *   POST /connection/test        → StepCodeConnectionDto（**裸 DTO，不走信封**）
 *   POST /quota                  { } → StepCodeStatusDto（强制刷新额度）
 *   POST /catalog/refresh        { } → StepCodeStatusDto
 *   POST /quota/credential       { mode:'password'|'manual'|'clear', account?, password?, token? }
 *                                 → StepCodeStatusDto（**非公开的开发者中心接口**；凭据只在提交时的
 *                                 请求体里过一趟，永远不回读）
 *
 * 除 /adopt 与 /connection/test 外全部走共享的 { ok, value } 信封，
 * 因此答案都是裸 DTO——createLineApi 已经把信封拆掉了。
 *
 * 凭据边界的另一半也写在这里：/login/manual 与 /quota/credential 的请求体是本文件里
 * **仅有的两处**带秘密的形状，它们只在这两个函数调用点的字面量里出现，
 * 既不进 URL、也不进日志，卡片那边同样没有别的地方可以读到它们。
 */
const api = createLineApi(STEP_CODE_ROUTE_PREFIX, STEP_CODE_PROVIDER_NAME)

export const get = api.get
export const post = api.post

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
