/** Compatibility exports for the API line; implementation is shared in common. */
export {
  ClaudeApiCapabilityMemory,
  ClaudeCapabilityMemory,
  claudeApiCapabilityMemoryPath,
  claudeCapabilityMemoryPath,
  parseClaudeApiCapabilityMemory,
  parseClaudeCapabilityMemory,
  serializeClaudeApiCapabilityMemory,
  serializeClaudeCapabilityMemory,
  CLAUDE_API_CAPABILITY_MEMORY_MAX_KEYS,
  CLAUDE_API_CAPABILITY_MEMORY_TTL_MS,
  CLAUDE_CAPABILITY_MEMORY_MAX_KEYS,
  CLAUDE_CAPABILITY_MEMORY_TTL_MS,
} from '../common/claude-capability-memory.ts'
export type {
  ClaudeApiCapabilityFacts,
  ClaudeApiCapabilityRecord,
  ClaudeApiFastModeConclusion,
  ClaudeCapabilityFacts,
  ClaudeCapabilityRecord,
  ClaudeFastModeConclusion,
} from '../common/claude-capability-memory.ts'
