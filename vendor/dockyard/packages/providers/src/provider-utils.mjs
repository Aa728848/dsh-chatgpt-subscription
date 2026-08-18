import { readFile } from "node:fs/promises";

export async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function decodeJwtPayload(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export function isoFromEpoch(value) {
  if (value === undefined || value === null || value === "") return null;
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function addSecondsIso(seconds, now = new Date()) {
  const numeric = Number(seconds);
  if (!Number.isFinite(numeric)) return null;
  return new Date(now.getTime() + numeric * 1000).toISOString();
}

export function finiteNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function stringValue(value) {
  return value === undefined || value === null || value === "" ? null : String(value);
}

export async function fetchJson(url, init = {}, { timeoutMs = 20_000, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const externalSignal = init?.signal;
  const abortFromCaller = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) controller.abort(externalSignal.reason);
  else externalSignal?.addEventListener?.("abort", abortFromCaller, { once: true });
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!response.ok) {
      const error = new Error(`Provider request failed (${response.status})`);
      error.status = response.status;
      error.bodyKeys = body && typeof body === "object" ? Object.keys(body) : [];
      const upstreamError = body?.error;
      const upstreamCode = typeof upstreamError === "string"
        ? upstreamError
        : upstreamError && typeof upstreamError === "object"
          ? upstreamError.code ?? upstreamError.type
          : body?.error_code ?? body?.code;
      if (typeof upstreamCode === "string" && upstreamCode.length > 0) error.upstreamCode = upstreamCode;
      throw error;
    }
    return { body, response };
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener?.("abort", abortFromCaller);
  }
}

export function redactError(error) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  const detail = error?.detail ? ` ${String(error.detail)}` : "";
  const code = error?.code !== undefined && error?.code !== null ? ` [code ${String(error.code)}]` : "";
  return `${message}${detail}${code}`
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]")
    .replace(/(access|refresh|id)[_-]?token["'=:\s]+[^,\s}]+/gi, "$1_token=[redacted]")
    // Vendor API key shapes: sk-…/sk-ant-…, xai-…, ghp_…, etc. Require a
    // dash/underscore prefix plus a long tail so normal words are not hit.
    .replace(/\b(?:sk|sk-ant|sk-proj|sk-svcacct|xai|agy|gsk|ghp|gho|ghu|github_pat|deepseek|pplx|nvapi|zai|glm)[-_][A-Za-z0-9_-]{12,}\b/gi, "[redacted]")
    .replace(/(api[_-]?key|client[_-]?secret|session[_-]?token|private[_-]?key)["'=:\s]+[^,\s}"']+/gi, "$1=[redacted]")
    .slice(0, 300);
}

export function recursiveQuotaWindows(value, { source, now = new Date(), prefix = "quota" } = {}) {
  const windows = [];

  function visit(node, path, label) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    const usedPercent = finiteNumber(node.used_percent ?? node.usedPercent);
    const remainingFraction = finiteNumber(node.remaining_fraction ?? node.remainingFraction);
    const remainingValue = finiteNumber(node.remaining);
    const limitValue = finiteNumber(node.limit);
    const resetAt = isoFromEpoch(node.reset_at ?? node.resetAt)
      ?? addSecondsIso(node.reset_after_seconds ?? node.resetAfterSeconds, now);
    const hasQuotaShape = usedPercent !== null || remainingFraction !== null || remainingValue !== null || limitValue !== null;

    if (hasQuotaShape) {
      let remaining = remainingValue;
      let limit = limitValue;
      let unit = stringValue(node.unit);
      if (remaining === null && remainingFraction !== null) {
        remaining = remainingFraction;
        limit = limit ?? 1;
        unit = unit ?? "fraction";
      } else if (remaining === null && usedPercent !== null) {
        remaining = Math.max(0, 100 - usedPercent);
        limit = limit ?? 100;
        unit = unit ?? "percent";
      }
      windows.push({
        id: path || prefix,
        name: label || path || prefix,
        remaining,
        limit,
        unit,
        resetAt,
        source,
      });
    }

    for (const [key, child] of Object.entries(node)) {
      if (child && typeof child === "object" && !Array.isArray(child)) {
        visit(child, path ? `${path}.${key}` : key, key);
      }
    }
  }

  visit(value, "", prefix);
  const unique = new Map();
  for (const window of windows) unique.set(window.id, window);
  return [...unique.values()];
}

export function selectPrimaryQuotaWindow(windows) {
  if (!windows?.length) return {};
  const preferred = windows.find((window) => /primary|weekly|five.?hour|5h/i.test(`${window.id} ${window.name}`));
  return preferred ?? windows[0];
}
