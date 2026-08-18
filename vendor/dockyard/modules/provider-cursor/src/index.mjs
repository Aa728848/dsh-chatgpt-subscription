import { defineProviderModule } from "../../../packages/core/src/provider-module.mjs";

export function createCursorModule({ driver = {} } = {}) {
  return defineProviderModule({
    id: "cursor",
    displayName: "Cursor",
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
  CursorSubscriptionDriver,
  createCursorCatalogLoader,
  createCursorCliExecutor,
  createCursorDriver,
  parseCursorAuthStatus,
  summarizeCursorCandidate,
} from "./driver.mjs";

export {
  cursorNativeTransportConstants,
  createCursorNativeExecutor,
  readCursorDesktopSession,
  resolveCursorAccessToken,
} from "./native-transport.mjs";
