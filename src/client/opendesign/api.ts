import { createLineApi } from '../common/line-api.ts'
import {
  OPENDESIGN_ROUTE_PREFIX,
  type OpenDesignAccountAction,
  type OpenDesignAuthResult,
  type OpenDesignLoginFlowDto,
  type OpenDesignSettingsUpdateDto,
  type OpenDesignUsageDto,
  type OpenDesignWebStatus,
} from '../../shared/opendesign-contracts.ts'

const api = createLineApi(OPENDESIGN_ROUTE_PREFIX, 'OpenDesign')

/**
 * The OpenDesign settings API, as the card uses it.
 *
 * Deliberately the same envelope and the same fetch shape every other provider
 * section uses, so the shared account-pool card and this helper read alike.
 */
export class OpenDesignApi {
  status(): Promise<OpenDesignWebStatus> {
    return api.get<OpenDesignWebStatus>('/status')
  }

  updateSettings(patch: OpenDesignSettingsUpdateDto): Promise<OpenDesignWebStatus> {
    return api.post('/settings', patch).then(() => this.status())
  }

  accountAction(
    action: OpenDesignAccountAction,
    body: { accountId?: string; alias?: string; strategy?: string; apiKey?: string; baseURL?: string } = {},
  ): Promise<OpenDesignWebStatus> {
    return api.post<OpenDesignWebStatus>('/accounts', { action, ...body })
  }

  /** Verify a key without storing it; the host answers the verdict directly. */
  testKey(body: { apiKey?: string; accountId?: string; baseURL?: string }): Promise<OpenDesignAuthResult> {
    return api.post<OpenDesignAuthResult>('/accounts', { action: 'test', ...body })
  }

  /** Start the browser device-authorization sign-in. */
  startLogin(): Promise<OpenDesignLoginFlowDto> {
    return api.post<OpenDesignLoginFlowDto>('/login/start', {})
  }

  /** One poll of the pending sign-in; the host throttles it to the advertised interval. */
  loginStatus(id: string): Promise<OpenDesignLoginFlowDto> {
    return api.get(`/login/status?id=${encodeURIComponent(id)}`)
  }

  cancelLogin(id: string): Promise<{ cancelled: boolean }> {
    return api.post<{ cancelled: boolean }>('/login/cancel', { id })
  }

  /** Read each OAuth account's wallet balance once (one upstream call per account). */
  readUsage(): Promise<{ usage: OpenDesignUsageDto; status: OpenDesignWebStatus }> {
    return api.post('/usage', {})
  }

  setEnabledModels(enabledModelIds: string[] | null): Promise<OpenDesignWebStatus> {
    return api.post<OpenDesignWebStatus>('/models', { enabledModelIds })
  }

  setContextWindow(model: string, contextWindow: number | null): Promise<OpenDesignWebStatus> {
    return api.post<OpenDesignWebStatus>('/models/context-window', { model, contextWindow })
  }

  setVisibility(model: string, visible: boolean): Promise<OpenDesignWebStatus> {
    return api.post<OpenDesignWebStatus>('/models/visibility', { model, visible })
  }

  setVisibilityAll(mode: 'all' | 'none' | 'invert'): Promise<OpenDesignWebStatus> {
    return api.post<OpenDesignWebStatus>('/models/visibility-all', { mode })
  }

  refreshCatalog(): Promise<{ added: string[]; status: OpenDesignWebStatus }> {
    return api.post('/catalog/refresh', {})
  }
}
