import type { FetchConfigurationDto } from '../shared/contracts.ts'

export const DEFAULT_FETCH_MAX_BODY_CHARS = 100_000
export const DEFAULT_FETCH_MAX_RESPONSE_BYTES = 2 * 1024 * 1024

export function positiveFetchLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value === undefined ? fallback : value
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new Error(`${name} must be a positive safe integer.`)
  return resolved
}

export function resolveFetchConfiguration(config: Partial<FetchConfigurationDto>): FetchConfigurationDto {
  const fetchProvider = config.fetchProvider ?? 'auto'
  if (fetchProvider !== 'auto' && fetchProvider !== 'plugin' && fetchProvider !== 'dsh') {
    throw new Error('fetchProvider must be auto, plugin, or dsh.')
  }
  return {
    fetchProvider,
    fetchMaxBodyChars: positiveFetchLimit(config.fetchMaxBodyChars, DEFAULT_FETCH_MAX_BODY_CHARS, 'fetchMaxBodyChars'),
    fetchMaxResponseBytes: positiveFetchLimit(config.fetchMaxResponseBytes, DEFAULT_FETCH_MAX_RESPONSE_BYTES, 'fetchMaxResponseBytes'),
  }
}
