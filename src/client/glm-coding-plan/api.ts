import { GLM_CODING_PLAN_ROUTE_PREFIX } from '../../shared/glm-coding-plan-contracts.ts'
import { createLineApi } from '../common/line-api.ts'

/**
 * 本线路的 host 路由由这一个文件描述，卡片与输入框胶囊都从这里取。
 *
 * **路由表是与 W6 的约定**：host 侧 src/host/glm-coding-plan/routes.ts 尚未交付，
 * 下表按计划 §6.1（"/glm-coding-plan/api 全套"）与兄弟线路的命名习惯定下，
 * 一旦 host 侧拼写不同，只需要改这一个文件。
 *
 *   GET  /status          → GlmStatusDto（页面的唯一读口）
 *   POST /settings        GlmSettingsUpdateDto → GlmStatusDto（开关、模型勾选、上下文窗口、档位）
 *   POST /accounts        { action, accountId } / { action:'strategy', strategy } → GlmStatusDto
 *   POST /login/start     { region } → GlmLoginFlowStatus
 *   GET  /login/status    → GlmLoginFlowStatus（浏览器授权不由卡片控制，卡片跟随 host）
 *   POST /login/cancel    → GlmLoginFlowStatus
 *   POST /login/manual    { region, code } → GlmStatusDto（手工粘贴兜底；请求体刻意不在冻结契约里）
 *   POST /adopt           { region } → GlmAdoptResultDto（失败永不阻断，卡片据 reason 给文案）
 *   POST /connection/test → GlmConnectionDto
 *   POST /quota           → GlmStatusDto（强制刷新配额）
 *   POST /catalog/refresh → GlmStatusDto
 *
 * 除 adopt 与 connection/test 外，全部走共享的 { ok, value } 信封，
 * 因此答案都是裸 DTO——createLineApi 已经把信封拆掉了。
 */
const api = createLineApi(GLM_CODING_PLAN_ROUTE_PREFIX, 'GLM（ZCode 账号）')

export const get = api.get
export const post = api.post

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
