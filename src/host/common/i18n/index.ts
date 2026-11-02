/**
 * Host-side language support: the runtime the client mirror feeds, the lookup
 * every Host composer reads, and the provider-name table built on it.
 * @module dsh-chatgpt-subscription/host/i18n
 */
export {
  currentLocale, HostLocaleRuntime, hostLocaleRuntime, installHostLocale,
} from './runtime.ts'
export { HOST_LOCALES, interpolate, t, translate } from './t.ts'
export { localizedProviderName } from './provider-name.ts'
export type { HostLocaleKey } from './zh.ts'
export { en } from './en.ts'
export { ru } from './ru.ts'
export { zh } from './zh.ts'
