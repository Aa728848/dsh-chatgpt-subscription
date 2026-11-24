/**
 * Copy of the shared model checklist's split vendor view.
 *
 * The checklist owns this namespace so every provider line gets the same
 * vendor-view wording without carrying its own copy of these keys; a line may
 * still override any label through the checklist's `labels` prop.
 */
export const NS_MODEL_CHECKLIST = 'dsh-model-checklist'

const zh = {
  allGroups: '全部',
  enabledGroup: '已启用',
  otherGroup: '其他',
  searchPlaceholder: '搜索模型或厂商…',
  noMatches: '没有匹配的模型',
  groupsNav: '模型厂商',
}

export type ModelChecklistLocaleKey = keyof typeof zh

const en: Record<ModelChecklistLocaleKey, string> = {
  allGroups: 'All',
  enabledGroup: 'Enabled',
  otherGroup: 'Other',
  searchPlaceholder: 'Search models or vendors…',
  noMatches: 'No matching models',
  groupsNav: 'Model vendors',
}

export const modelChecklistZh: Record<ModelChecklistLocaleKey, string> = zh

export const dictionaries = { zh, en }
