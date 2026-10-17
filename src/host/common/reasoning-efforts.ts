export function orderReasoningEfforts(efforts: readonly string[], strengthOrder: readonly string[]): string[] {
  const rank = new Map(strengthOrder.map((effort, index) => [effort, index]))
  if (efforts.some((effort) => !rank.has(effort))) return [...efforts]
  return [...efforts].sort((left, right) => rank.get(left)! - rank.get(right)!)
}
