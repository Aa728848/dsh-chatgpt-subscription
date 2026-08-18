/**
 * Shared vocabulary for provider-owned sessions.
 *
 * A provider may obtain an official session from a CLI, a desktop client,
 * browser OAuth, or an OAuth file. The transport and status reader remain
 * provider-specific; this module only keeps the account contract neutral.
 */
export const OFFICIAL_SESSION_AUTH_KIND = "official_session";
export const LEGACY_OFFICIAL_SESSION_AUTH_KINDS = Object.freeze(["official_cli_session"]);

export const OFFICIAL_SESSION_SOURCE_KINDS = Object.freeze({
  CLI: "cli",
  DESKTOP_APP: "desktop_app",
  BROWSER: "browser",
  OAUTH_FILE: "oauth_file",
  OTHER: "other",
});

export function isOfficialSessionAuthKind(value) {
  const kind = typeof value === "string" ? value : value?.kind;
  return kind === OFFICIAL_SESSION_AUTH_KIND || LEGACY_OFFICIAL_SESSION_AUTH_KINDS.includes(kind);
}

/**
 * Normalize a public status result returned by an injected official-client
 * reader. Readers may return text, a JSON object, or { output, source }.
 */
export function normalizeOfficialSessionResult(value, {
  source = "official_session",
  sourceKind = OFFICIAL_SESSION_SOURCE_KINDS.OTHER,
} = {}) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return { output: value, source, sourceKind };
  if (typeof value !== "object") return null;
  let payload = typeof value.output === "string" ? value.output : "";
  if (!payload) {
    try {
      payload = JSON.stringify(value.status ?? value);
    } catch {
      payload = "";
    }
  }
  return {
    ...value,
    output: payload,
    source: value.source ?? source,
    sourceKind: value.sourceKind ?? sourceKind,
  };
}

export function officialSessionResources({
  sourceKind = OFFICIAL_SESSION_SOURCE_KINDS.OTHER,
  authSource = null,
  extra = {},
} = {}) {
  return {
    accountScope: "active_official_session",
    sessionSource: sourceKind,
    ...(authSource ? { authSource } : {}),
    ...extra,
  };
}
