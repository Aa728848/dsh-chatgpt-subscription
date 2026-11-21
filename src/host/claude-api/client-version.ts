/** Compatibility exports; the shared implementation lives in common/claude-code-version.ts. */
export {
  ClaudeApiClientVersionResolver,
  ClaudeCodeVersionResolver,
  ClaudeCodeVersionConfigurationError,
  claudeApiClientVersionPath,
  claudeCodeClientVersionPath,
  isClaudeApiCliVersion,
  isClaudeCodeCliVersion,
  parseClaudeApiClientVersion,
  parseClaudeCodeClientVersion,
  serializeClaudeApiClientVersion,
  serializeClaudeCodeClientVersion,
  setClaudeCodeVersionPin,
} from '../common/claude-code-version.ts'
export type {
  ClaudeApiClientVersionOptions,
  ClaudeCodeLine,
  ClaudeCodeVersionOptions,
  ClaudeCodeVersionProfile,
  ClaudeCodeVersionSelection,
  PersistedClaudeApiClientVersion,
  PersistedClaudeCodeClientVersion,
} from '../common/claude-code-version.ts'
