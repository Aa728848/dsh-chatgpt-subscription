/**
 * 「派发卡片」在 locale 服务里的命名空间。
 *
 * 与其余线路同一个命名习惯（`dsh-<线路>`）：账单相关的文案自成一表，
 * 不去占本插件通用字典的键位。
 */
export const NS_DISPATCH_LEDGER = 'dsh-dispatch-ledger' as const

/** 中文文案。 */
export const zh = {
  mandateTitle: '派发子代理',
  mandateTitleFork: '派发子代理（继承上下文）',
  mandatePreparing: '正在组装派发',
  mandateRunning: '子代理启动中',
  mandateDone: '已派出',
  mandateFailed: '派发被拒',
  mandateExpand: '展开这次派发',
  mandateCollapse: '收起这次派发',
  mandateBrief: '工作项',
  mandateRun: '运行',
  mandateIdem: '幂等键',
  mandateRoute: '路由',
  mandateTask: '任务引用',
  mandateBoundary: '边界',
  mandateFollowup: '后续上下文',
  mandateBody: '任务正文',
  mandateResult: '结果',
  mandateRawShow: '原始参数',
  mandateRawHide: '收起原始参数',
  mandateNoHeader: '这次调用没有带 mandate 头（仅审计，无法去重）',
  mandateNoBody: '（没有正文）',
}

/** 该表全部键。 */
export type DispatchLedgerLocaleKey = keyof typeof zh

/** 英文文案。 */
export const en: Record<DispatchLedgerLocaleKey, string> = {
  mandateTitle: 'Subagent dispatch',
  mandateTitleFork: 'Subagent dispatch (inherits context)',
  mandatePreparing: 'Assembling the dispatch',
  mandateRunning: 'Starting the subagent',
  mandateDone: 'Dispatched',
  mandateFailed: 'Dispatch refused',
  mandateExpand: 'Expand this dispatch',
  mandateCollapse: 'Collapse this dispatch',
  mandateBrief: 'Work item',
  mandateRun: 'Run',
  mandateIdem: 'Idem key',
  mandateRoute: 'Route',
  mandateTask: 'Task refs',
  mandateBoundary: 'Boundary',
  mandateFollowup: 'Follow-up context',
  mandateBody: 'Task body',
  mandateResult: 'Result',
  mandateRawShow: 'Raw arguments',
  mandateRawHide: 'Hide raw arguments',
  mandateNoHeader: 'This call carries no mandate header (audited only, cannot be de-duplicated)',
  mandateNoBody: '(no body)',
}

/** 注册进 locale 服务的双语字典。 */
export const dictionaries = { zh, en }
