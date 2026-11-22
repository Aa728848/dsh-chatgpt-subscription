/** Copy of the one-shot "compact after this turn" row in the composer's model menu. */
export const NS_COMPACT_AFTER_TURN = 'dsh-compact-after-turn'

export const zh = {
  label: '本轮结束后压缩',
  infoLabel: '关于本轮结束后压缩',
  hint: '开启后，这一轮对话结束时自动压缩一次上下文，压缩完成后开关自动关闭。手动停止的那一轮不算，开关会保留到下一轮结束。',
  stateArmed: '待压缩',
  stateCompacting: '压缩中…',
  unavailable: '当前 DSH 没有可用的压缩引擎。',
  lastCompacted: '上次：已压缩。',
  lastNothing: '上次：没有可压缩的内容。',
  lastFailed: '上次压缩失败：{detail}',
  errorBusy: '正在压缩，完成后才能切换。',
  errorFailed: '切换失败：{message}',
}

export type CompactAfterTurnLocaleKey = keyof typeof zh

export const en: Record<CompactAfterTurnLocaleKey, string> = {
  label: 'Compact after this turn',
  infoLabel: 'About compacting after this turn',
  hint: 'When on, the context is compacted once as soon as this turn ends, then the switch turns itself off. A turn you stop yourself does not count: the switch stays on until the next turn ends.',
  stateArmed: 'Pending',
  stateCompacting: 'Compacting…',
  unavailable: 'This DSH has no compaction engine available.',
  lastCompacted: 'Last time: compacted.',
  lastNothing: 'Last time: nothing to compact.',
  lastFailed: 'Last compaction failed: {detail}',
  errorBusy: 'Compaction is running; the switch unlocks when it finishes.',
  errorFailed: 'Could not change the switch: {message}',
}

export const dictionaries = { zh, en }
