import { ValidationError } from "../../core/src/errors.mjs";

function effortName(id) {
  return String(id)
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function modelCapacityText(value) {
  if (!Number.isInteger(value) || value <= 0) return null;
  return `${new Intl.NumberFormat().format(value)} tokens`;
}

function modelDescription(model) {
  const details = [];
  if (typeof model.description === "string" && model.description.length > 0) {
    details.push(model.description);
  }
  const context = modelCapacityText(model.contextWindow);
  details.push(context ? `上下文 ${context}` : "上下文未由 provider 返回");
  const output = modelCapacityText(model.maxTokens);
  if (output) details.push(`输出上限 ${output}`);
  return details.join(" · ");
}

/**
 * Keep the DSH-facing reasoning contract small and lossless. Provider modules
 * own the source-specific discovery; this bridge only filters malformed data
 * before handing it to DSH's model directory.
 */
export function normalizeDshReasoning(reasoning) {
  if (!reasoning || !Array.isArray(reasoning.efforts)) return undefined;
  const efforts = [];
  const seen = new Set();
  for (const effort of reasoning.efforts) {
    if (!effort || typeof effort.id !== "string" || effort.id.length === 0 || seen.has(effort.id)) continue;
    const name = typeof effort.name === "string" && effort.name.length > 0
      ? effort.name
      : effortName(effort.id);
    const normalized = {
      id: effort.id,
      name,
      ...(typeof effort.description === "string" ? { description: effort.description } : {}),
    };
    efforts.push(normalized);
    seen.add(effort.id);
  }
  if (efforts.length === 0) return undefined;
  const defaultEffort = typeof reasoning.defaultEffort === "string"
    && seen.has(reasoning.defaultEffort)
    ? reasoning.defaultEffort
    : undefined;
  return {
    efforts,
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
  };
}

function providerCatalogModels(providerId, catalog) {
  if (!Array.isArray(catalog?.models)) return [];
  const seen = new Set();
  return catalog.models
    .filter((model) => {
      if (!model || typeof model.id !== "string" || model.id.length === 0 || seen.has(model.id)) return false;
      seen.add(model.id);
      return true;
    })
    .map((model) => {
      const reasoning = normalizeDshReasoning(model.reasoning);
      return {
        provider: providerId,
        id: model.id,
        name: typeof model.name === "string" && model.name.length > 0 ? model.name : model.id,
        description: modelDescription(model),
        ...(Array.isArray(model.inputModalities) ? { inputModalities: [...model.inputModalities] } : {}),
        ...(Number.isInteger(model.contextWindow) ? { context: { contextWindow: model.contextWindow } } : {}),
        ...(Number.isInteger(model.maxTokens) ? { defaultMaxTokens: model.maxTokens } : {}),
        ...(reasoning ? { reasoning } : {}),
      };
    });
}

function manifestFor(runtime, providerId) {
  return runtime.listProviderManifests?.().find((manifest) => manifest.id === providerId) ?? null;
}

/**
 * Dockyard owns provider discovery for all modules, but a discovered catalog
 * is not the same thing as an imported account. Keep the model directory
 * scoped to providers that have an account in Dockyard's pool; otherwise a
 * local CLI/model registry would make every optional provider look enabled.
 * Test doubles that do not expose a snapshot retain the old catalog behavior.
 */
function providerHasConnectedAccount(runtime, providerId) {
  if (typeof runtime.snapshot !== "function") return true;
  const snapshot = runtime.snapshot();
  if (!Array.isArray(snapshot?.providers)) return true;
  const provider = snapshot.providers.find((entry) => entry?.providerId === providerId);
  return Array.isArray(provider?.accounts) && provider.accounts.length > 0;
}

function requestHasImage(value) {
  if (Array.isArray(value)) return value.some((item) => requestHasImage(item));
  if (!value || typeof value !== "object") return false;
  if (value.type === "image") return true;
  return Object.values(value).some((item) => requestHasImage(item));
}

function requestHasImageInCurrentTurn(request = {}) {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  if (messages.length > 0) {
    const current = messages.at(-1)?.role === "user"
      ? messages.at(-1)
      : [...messages].reverse().find((message) => message?.role === "user") ?? messages.at(-1);
    return requestHasImage(current?.content ?? current?.text);
  }
  return requestHasImage(request.input);
}

function unsupportedContentError(message) {
  const error = new ValidationError(message);
  error.code = "UNSUPPORTED_CONTENT";
  return error;
}

/**
 * Adapt Dockyard's provider-neutral routes to the DSH LLM seam.
 *
 * This object intentionally does not import DSH at module load time. DSH owns
 * the concrete LlmAdapter class and only requires this contract at runtime;
 * keeping the bridge structural lets the local page and unit tests run without
 * installing DSH into Dockyard's own workspace.
 */
export function createDockyardLlmAdapter({ runtime, providerIds, attachmentsResolver = null } = {}) {
  if (!runtime) throw new ValidationError("Dockyard runtime is required");
  const owned = [...(providerIds ?? runtime.listProviderIds?.() ?? [])];
  if (owned.length === 0) throw new ValidationError("At least one Dockyard provider is required");
  const catalogPromises = new Map();

  async function ensureRuntimeReady() {
    if (typeof runtime.init === "function") await runtime.init();
  }

  async function providerCatalog(provider) {
    const existing = catalogPromises.get(provider);
    if (existing) return existing;
    const promise = Promise.resolve().then(() => runtime.getCatalog(provider)).finally(() => {
      if (catalogPromises.get(provider) === promise) catalogPromises.delete(provider);
    });
    catalogPromises.set(provider, promise);
    return promise;
  }

  return {
    providerInfo(provider) {
      const manifest = manifestFor(runtime, provider);
      return { id: provider, name: manifest?.displayName ?? provider };
    },

    providerRetryPolicy() {
      return undefined;
    },

    async listModels(provider) {
      await ensureRuntimeReady();
      if (!providerHasConnectedAccount(runtime, provider)) return [];
      const catalog = await providerCatalog(provider);
      return providerCatalogModels(provider, catalog);
    },

    async resolveModel(provider, model) {
      await ensureRuntimeReady();
      if (!providerHasConnectedAccount(runtime, provider)) return { provider, id: model, name: model };
      const catalog = await providerCatalog(provider);
      return providerCatalogModels(provider, catalog).find((entry) => entry.id === model)
        ?? { provider, id: model, name: model };
    },

    async *stream(options) {
      await ensureRuntimeReady();
      if (!providerHasConnectedAccount(runtime, options.provider)) {
        throw new ValidationError(`Provider ${options.provider} has no connected Dockyard account`);
      }
      const catalog = await providerCatalog(options.provider);
      const model = providerCatalogModels(options.provider, catalog).find((entry) => entry.id === options.model);
      if (requestHasImageInCurrentTurn(options) && Array.isArray(model?.inputModalities)
        && !model.inputModalities.includes("image")) {
        throw unsupportedContentError(
          `模型 ${model.name ?? model.id} 的实时 provider catalog 未声明图片输入能力`,
        );
      }
      const request = model
        ? {
            ...options,
            ...(model.context ? { modelContext: { ...model.context } } : {}),
            ...(model.defaultMaxTokens !== undefined
              ? { modelContext: { ...(model.context ?? {}), maxTokens: model.defaultMaxTokens } }
              : {}),
          }
        : options;
      const attachments = typeof attachmentsResolver === "function"
        ? attachmentsResolver()
        : undefined;
      const stream = await runtime.stream(options.provider, request, {
        accountId: options.accountId,
        requestId: options.requestId,
        sessionId: options.sessionId,
        ...(attachments ? { attachments } : {}),
      });
      for await (const chunk of stream) yield chunk;
    },

    providers() {
      return [...owned];
    },
  };
}
