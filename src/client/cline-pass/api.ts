import { createLineApi } from '../common/line-api.ts'
import {
  CLINE_PASS_ROUTE_PREFIX,
  type ClinePassAccountAction,
  type ClinePassAuthResult,
  type ClinePassHistoryRowDto,
  type ClinePassLoginFlowDto,
  type ClinePassProbeResultDto,
  type ClinePassSettingsUpdateDto,
  type ClinePassTestResultDto,
  type ClinePassUsageDto,
  type ClinePassValidateResultDto,
  type ClinePassWebStatus,
} from '../../shared/cline-pass-contracts.ts'

const api = createLineApi(CLINE_PASS_ROUTE_PREFIX, 'Cline Pass')

/** What one pin write answers with. */
export interface ClinePassPinResult {
  pin: { upstreams: string[]; exclude: string[]; pinMode: 'strict' | 'preferred'; sort: string }
  warnings: string[]
  status: ClinePassWebStatus
}

/**
 * The Cline Pass settings API, as the card uses it.
 *
 * Deliberately the same envelope and the same fetch shape every other provider
 * section uses, so the shared account-pool card and this helper read alike.
 */
export class ClinePassApi {
  status(): Promise<ClinePassWebStatus> {
    return api.get<ClinePassWebStatus>('/status')
  }

  updateSettings(patch: ClinePassSettingsUpdateDto): Promise<ClinePassWebStatus> {
    return api.post('/settings', patch).then(() => this.status())
  }

  accountAction(
    action: ClinePassAccountAction,
    body: { accountId?: string; alias?: string; strategy?: string; apiKey?: string; baseURL?: string } = {},
  ): Promise<ClinePassWebStatus> {
    return api.post<ClinePassWebStatus>('/accounts', { action, ...body })
  }

  /** Verify a key without storing it; the host answers the verdict directly. */
  testKey(body: { apiKey?: string; accountId?: string; baseURL?: string }): Promise<ClinePassAuthResult> {
    return api.post<ClinePassAuthResult>('/accounts', { action: 'test', ...body })
  }

  /** Start the Cline device-code sign-in. */
  startLogin(): Promise<ClinePassLoginFlowDto> {
    return api.post<ClinePassLoginFlowDto>('/login/start', {})
  }

  /** One poll of the pending sign-in; the host throttles it to WorkOS's interval. */
  loginStatus(id: string): Promise<ClinePassLoginFlowDto> {
    return api.get(`/login/status?id=${encodeURIComponent(id)}`)
  }

  cancelLogin(id: string): Promise<{ cancelled: boolean }> {
    return api.post<{ cancelled: boolean }>('/login/cancel', { id })
  }

  setEnabledModels(enabledModelIds: string[] | null): Promise<ClinePassWebStatus> {
    return api.post<ClinePassWebStatus>('/models', { enabledModelIds })
  }

  setContextWindow(model: string, contextWindow: number | null): Promise<ClinePassWebStatus> {
    return api.post<ClinePassWebStatus>('/models/context-window', { model, contextWindow })
  }

  pinModel(
    model: string,
    pin: { upstreams?: string[]; exclude?: string[]; pinMode?: string; sort?: string },
  ): Promise<ClinePassPinResult> {
    return api.post<ClinePassPinResult>('/models/pin', { model, ...pin })
  }

  resetPin(model: string): Promise<{ status: ClinePassWebStatus }> {
    return api.post<{ status: ClinePassWebStatus }>('/models/reset', { model })
  }

  probe(model: string): Promise<{ result: ClinePassProbeResultDto; status: ClinePassWebStatus }> {
    return api.post('/models/probe', { model })
  }

  validate(model: string): Promise<{ result: ClinePassValidateResultDto; status: ClinePassWebStatus }> {
    return api.post('/models/validate', { model })
  }

  test(model: string, pin: { upstreams?: string[]; exclude?: string[] } = {}): Promise<{ result: ClinePassTestResultDto; status: ClinePassWebStatus }> {
    return api.post('/models/test', { model, ...pin })
  }

  setVisibility(model: string, visible: boolean): Promise<ClinePassWebStatus> {
    return api.post<ClinePassWebStatus>('/models/visibility', { model, visible })
  }

  setVisibilityAll(mode: 'all' | 'none' | 'invert'): Promise<ClinePassWebStatus> {
    return api.post<ClinePassWebStatus>('/models/visibility-all', { mode })
  }

  refreshCatalog(): Promise<{ added: string[]; sources: string[]; status: ClinePassWebStatus }> {
    return api.post('/catalog/refresh', {})
  }

  readUsage(): Promise<{ usage: ClinePassUsageDto; status: ClinePassWebStatus }> {
    return api.post('/usage', {})
  }

  history(limit = 25, model = ''): Promise<{ total: number; entries: ClinePassHistoryRowDto[] }> {
    const query = new URLSearchParams({ limit: String(limit), ...(model === '' ? {} : { model }) })
    return api.get('/history?' + query.toString())
  }
}
