import { defineProviderModule } from "../../../packages/core/src/provider-module.mjs";

export function createClaudeModule({ driver = {} } = {}) {
  return defineProviderModule({
    id: "claude",
    displayName: "Claude",
    capabilities: [
      "oauth_discovery",
      "oauth_import",
      "oauth_authorization",
      "oauth_refresh",
      "quota",
      "catalog",
      "invoke",
      "stream",
    ],
    driver,
  });
}

export {
  ClaudeSubscriptionDriver,
  claudeRequestPrompt,
  createClaudeCatalogLoader,
  createClaudeCliExecutor,
  createClaudeDriver,
  parseClaudeAuthStatus,
  summarizeClaudeCandidate,
} from "./driver.mjs";

export {
  buildClaudeRequest,
  claudeNativeTransportConstants,
  createClaudeNativeExecutor,
  resolveClaudeAccessToken,
} from "./native-transport.mjs";
