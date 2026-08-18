import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

function cliFailure(code, signal, output, errorOutput, providerId) {
  const error = new Error(`${providerId ?? "provider"} CLI failed (${signal ?? code})`);
  error.code = code;
  error.detail = String(errorOutput || output || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  return error;
}

export function parseJsonOutput(output) {
  if (output && typeof output === "object") return output;
  try {
    return JSON.parse(String(output));
  } catch {
    for (const line of String(output ?? "").split(/\r?\n/).reverse()) {
      if (!line.trim()) continue;
      try {
        return JSON.parse(line);
      } catch {
        // The official CLIs may print a human-readable line before JSON.
      }
    }
    return null;
  }
}

export function runCliCommand(command, args, {
  env = process.env,
  cwd,
  timeoutMs = 30_000,
  signal,
  providerId,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      ...(cwd ? { cwd } : {}),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(signal ? { signal } : {}),
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let forceTimer = null;
    let terminationRequested = false;
    const terminate = () => {
      if (terminationRequested) return;
      terminationRequested = true;
      try { child.kill("SIGTERM"); } catch { /* process is already gone */ }
      forceTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* process is already gone */ }
      }, 1_000);
      forceTimer.unref?.();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      reject(error);
    });
    child.once("close", (code, closeSignal) => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      const output = Buffer.concat(stdout).toString("utf8");
      const errorOutput = Buffer.concat(stderr).toString("utf8");
      if (code === 0) {
        resolve({ output, errorOutput });
        return;
      }
      reject(cliFailure(code, timedOut ? "SIGTERM" : closeSignal, output, errorOutput, providerId));
    });
  });
}

export function runCliStreamingCommand(command, args, {
  env = process.env,
  cwd,
  timeoutMs = 300_000,
  signal,
  providerId,
} = {}) {
  return (async function* streamLines() {
    const child = spawn(command, args, {
      env,
      ...(cwd ? { cwd } : {}),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(signal ? { signal } : {}),
    });
    const stdout = [];
    const stderr = [];
    let spawnError = null;
    let timedOut = false;
    let closedResult = null;
    let forceTimer = null;
    let timer = null;
    let terminationRequested = false;
    const terminate = () => {
      if (closedResult || terminationRequested) return;
      terminationRequested = true;
      try { child.kill("SIGTERM"); } catch { /* process is already gone */ }
      forceTimer = setTimeout(() => {
        if (!closedResult) {
          try { child.kill("SIGKILL"); } catch { /* process is already gone */ }
        }
      }, 1_000);
      forceTimer.unref?.();
    };
    timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => { spawnError = error; });
    const closed = new Promise((resolve) => {
      child.once("close", (code, closeSignal) => {
        closedResult = { code, closeSignal };
        clearTimeout(timer);
        if (forceTimer) clearTimeout(forceTimer);
        resolve(closedResult);
      });
    });
    const reader = createInterface({ input: child.stdout });
    try {
      for await (const line of reader) {
        stdout.push(line);
        yield line;
      }
    } finally {
      reader.close();
      terminate();
      clearTimeout(timer);
    }
    const result = await closed;
    const output = stdout.join("\n");
    const errorOutput = Buffer.concat(stderr).toString("utf8");
    if (spawnError) throw spawnError;
    if (result.code !== 0) {
      throw cliFailure(
        result.code,
        timedOut ? "SIGTERM" : result.closeSignal,
        output,
        errorOutput,
        providerId,
      );
    }
  })();
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => contentText(part)).filter(Boolean).join("");
  if (!content || typeof content !== "object") return "";
  if (content.type === "image") return "[previous image attachment omitted by native CLI]";
  return content.text ?? content.value ?? content.content ?? content.delta ?? "";
}

/** Return true when a DSH request contains a durable image content block. */
export function contentHasImage(value) {
  if (Array.isArray(value)) return value.some((item) => contentHasImage(item));
  if (!value || typeof value !== "object") return false;
  if (value.type === "image") return true;
  return Object.values(value).some((item) => contentHasImage(item));
}

/**
 * Detect an image in the turn being submitted now. Older session messages may
 * still contain a failed image turn; a text-only CLI must be able to continue
 * that session instead of failing every later text message again.
 */
export function contentHasImageInCurrentTurn(request = {}) {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  if (messages.length > 0) {
    const current = messages.at(-1)?.role === "user"
      ? messages.at(-1)
      : [...messages].reverse().find((message) => message?.role === "user") ?? messages.at(-1);
    return contentHasImage(current?.content ?? current?.text);
  }
  return contentHasImage(request.input);
}

export function unsupportedContentError(providerId, detail) {
  const error = new Error(detail ?? `${providerId ?? "provider"} does not support this content through its native transport`);
  error.code = "UNSUPPORTED_CONTENT";
  error.providerId = providerId ?? null;
  return error;
}

export function cliRequestPrompt(request = {}) {
  const sections = [];
  if (typeof request.system === "string" && request.system.length > 0) {
    sections.push(`system:\n${request.system}`);
  }
  for (const message of Array.isArray(request.messages) ? request.messages : []) {
    const text = contentText(message?.content ?? message?.text);
    if (!text) continue;
    sections.push(`${message?.role ?? "message"}:\n${text}`);
  }
  return sections.join("\n\n") || "Continue the conversation.";
}

function eventName(payload) {
  return String(payload?.type ?? payload?.event ?? payload?.subtype ?? "").toLowerCase();
}

function collectText(value, result = []) {
  if (typeof value === "string") {
    if (value) result.push(value);
    return result;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, result);
    return result;
  }
  if (!value || typeof value !== "object") return result;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[-_]/g, "");
    if (["text", "textdelta", "contentdelta", "outputtext", "reasoningtext"].includes(normalized)) {
      collectText(child, result);
      continue;
    }
    if (normalized === "content" && (typeof child === "string" || Array.isArray(child))) {
      collectText(child, result);
      continue;
    }
    if (normalized === "delta" && (typeof child === "string" || typeof child === "object")) {
      collectText(child, result);
    }
  }
  return result;
}

export function cliEventText(payload) {
  if (!payload || typeof payload !== "object") return [];
  const name = eventName(payload);
  if (/error|failed|cancelled/.test(name)) return [];
  const candidates = [
    payload.event?.delta,
    payload.delta,
    payload.message?.content,
    payload.content,
    payload.assistant?.content,
    payload.response?.content,
  ];
  const values = candidates.flatMap((candidate) => collectText(candidate, []));
  if (values.length > 0) return values;
  if (/text|message|assistant|delta|content/.test(name) && !/result|tool/.test(name)) {
    return collectText(payload, []).filter((value) => value !== payload.type && value !== payload.event);
  }
  return [];
}

export function cliEventResult(payload) {
  if (!payload || typeof payload !== "object") return null;
  const result = payload.result ?? payload.response;
  if (typeof result === "string") return { text: result, usage: payload.usage };
  if (!result || typeof result !== "object") return null;
  return {
    text: contentText(result.text ?? result.content ?? result.response ?? result.output),
    usage: result.usage ?? payload.usage,
    error: result.error ?? payload.error,
    status: result.status ?? payload.status,
    isError: result.is_error ?? payload.is_error,
  };
}

export function cliEventUsage(payload) {
  const usage = payload?.usage ?? payload?.message?.usage ?? payload?.result?.usage;
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = Number(usage.input_tokens ?? usage.inputTokens ?? usage.input);
  const outputTokens = Number(usage.output_tokens ?? usage.outputTokens ?? usage.output);
  const totalTokens = Number(usage.total_tokens ?? usage.totalTokens ?? usage.total);
  if (!Number.isFinite(inputTokens) && !Number.isFinite(outputTokens) && !Number.isFinite(totalTokens)) return null;
  return {
    ...(Number.isFinite(inputTokens) ? { inputTokens } : {}),
    ...(Number.isFinite(outputTokens) ? { outputTokens } : {}),
    ...(Number.isFinite(totalTokens) ? { totalTokens } : {}),
    ...(Number.isFinite(Number(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens))
      ? { cacheReadInputTokens: Number(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens) }
      : {}),
  };
}

function appendDelta(current, next) {
  if (!next) return "";
  if (!current) return next;
  if (next.startsWith(current)) return next.slice(current.length);
  if (current.endsWith(next)) return "";
  return next;
}

/**
 * Execute an official provider CLI and normalize its native NDJSON stream to
 * the DSH text stream contract. The provider module owns the CLI and auth;
 * this transport never reads or prints credentials.
 */
export function createCliAgentExecutor({
  providerId,
  cliPath,
  env = process.env,
  cwd,
  timeoutMs = 300_000,
  outputFormat = "stream-json",
  buildArgs,
  commandRunner = runCliCommand,
  streamCommandRunner = runCliStreamingCommand,
} = {}) {
  if (!providerId) throw new Error("CLI agent executor requires providerId");
  if (!cliPath) throw new Error(`CLI agent executor requires a ${providerId} CLI path`);
  if (typeof buildArgs !== "function") throw new Error(`CLI agent executor requires args for ${providerId}`);

  return async function execute({ request = {}, invocation = {}, context = {} } = {}) {
    if (contentHasImageInCurrentTurn(request)) {
      throw unsupportedContentError(
        providerId,
        `${providerId} native CLI transport cannot receive DSH image attachments`,
      );
    }
    const resolvedEnv = { ...env, ...(context.env ?? {}) };
    const prompt = cliRequestPrompt(request);
    const args = await buildArgs({ request, invocation, context, prompt, outputFormat });
    return (async function* responseStream() {
      let text = "";
      let usage = null;
      let finishReason = "stop";
      yield { type: "block-start", index: 0, blockType: "text" };
      for await (const line of streamCommandRunner(cliPath, args, {
        env: resolvedEnv,
        cwd: context.cwd ?? cwd,
        timeoutMs,
        signal: request.signal,
        providerId,
      })) {
        const payload = parseJsonOutput(line);
        if (!payload) continue;
        const name = eventName(payload);
        if (/error|failed|cancelled/.test(name)) {
          const error = new Error(`${providerId} CLI returned an error`);
          error.detail = payload.error?.message ?? payload.error ?? payload.message ?? null;
          throw error;
        }
        for (const value of cliEventText(payload)) {
          const delta = appendDelta(text, value);
          if (!delta) continue;
          text += delta;
          yield { type: "text-delta", index: 0, text: delta };
        }
        const result = cliEventResult(payload);
        if (result) {
          if (result.status && !/success|completed|stop|ok/i.test(String(result.status))) {
            const error = new Error(`${providerId} CLI request did not complete`);
            error.detail = result.error ?? result.text ?? null;
            throw error;
          }
          if (result.isError) {
            const error = new Error(`${providerId} CLI request returned an error`);
            error.detail = result.error ?? null;
            throw error;
          }
          const delta = appendDelta(text, result.text);
          if (delta) {
            text += delta;
            yield { type: "text-delta", index: 0, text: delta };
          }
          usage = cliEventUsage({ usage: result.usage }) ?? usage;
        }
        usage = cliEventUsage(payload) ?? usage;
        if (payload.stop_reason || payload.stopReason) finishReason = payload.stop_reason ?? payload.stopReason;
      }
      yield { type: "block-end", index: 0, block: { type: "text", text } };
      if (usage) yield { type: "usage", usage };
      yield { type: "finish", reason: { kind: finishReason || "stop" } };
    })();
  };
}

function acpError(providerId, payload) {
  const message = payload?.error?.message
    ?? payload?.message
    ?? `${providerId} ACP request failed`;
  const error = new Error(String(message));
  error.code = payload?.error?.code ?? "ACP_ERROR";
  error.providerId = providerId;
  error.detail = payload?.error?.data ?? null;
  return error;
}

function acpUsage(value) {
  if (!value || typeof value !== "object") return null;
  const inputTokens = Number(value.inputTokens ?? value.input_tokens ?? value.input);
  const outputTokens = Number(value.outputTokens ?? value.output_tokens ?? value.output);
  const totalTokens = Number(value.totalTokens ?? value.total_tokens ?? value.total);
  if (!Number.isFinite(inputTokens) && !Number.isFinite(outputTokens) && !Number.isFinite(totalTokens)) return null;
  return {
    ...(Number.isFinite(inputTokens) ? { inputTokens } : {}),
    ...(Number.isFinite(outputTokens) ? { outputTokens } : {}),
    ...(Number.isFinite(totalTokens) ? { totalTokens } : {}),
  };
}

/**
 * Execute an Agent Client Protocol provider over its native JSON-RPC stdio
 * transport. This is deliberately provider-neutral: a module supplies the
 * command arguments and converts DSH content blocks to ACP blocks.
 */
export function createAcpAgentExecutor({
  providerId,
  cliPath,
  env = process.env,
  cwd,
  timeoutMs = 300_000,
  buildArgs = () => ["agent", "stdio"],
  promptBuilder,
  spawnImpl = spawn,
} = {}) {
  if (!providerId) throw new Error("ACP agent executor requires providerId");
  if (!cliPath) throw new Error(`ACP agent executor requires a ${providerId} CLI path`);
  if (typeof promptBuilder !== "function") throw new Error(`ACP agent executor requires a prompt for ${providerId}`);

  return async function execute({ request = {}, invocation = {}, context = {} } = {}) {
    const resolvedEnv = { ...env, ...(context.env ?? {}) };
    const args = await buildArgs({ request, invocation, context });
    const prompt = await promptBuilder({ request, invocation, context });
    return (async function* responseStream() {
      const child = spawnImpl(cliPath, args, {
        env: resolvedEnv,
        cwd: context.cwd ?? cwd,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      const reader = createInterface({ input: child.stdout });
      const pending = new Map();
      const notifications = [];
      const notificationWaiters = [];
      let nextId = 1;
      let spawnError = null;
      let closed = false;
      let timer;

      const rejectPending = (error) => {
        for (const entry of pending.values()) entry.reject(error);
        pending.clear();
        while (notificationWaiters.length) notificationWaiters.shift().resolve(null);
      };

      const enqueueNotification = (message) => {
        const waiter = notificationWaiters.shift();
        if (waiter) waiter.resolve(message);
        else notifications.push(message);
      };

      const onLine = (line) => {
        const message = parseJsonOutput(line);
        if (!message || typeof message !== "object") return;
        if (message.id !== undefined && pending.has(message.id)) {
          const entry = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) entry.reject(acpError(providerId, message));
          else entry.resolve(message.result ?? {});
          return;
        }
        if (typeof message.method === "string") enqueueNotification(message);
      };

      reader.on("line", onLine);
      child.stderr?.on("data", () => {});
      child.once("error", (error) => {
        spawnError = error;
        rejectPending(error);
      });
      child.once("close", (code, closeSignal) => {
        closed = true;
        if (pending.size > 0) {
          const error = spawnError ?? new Error(`${providerId} ACP exited (${closeSignal ?? code})`);
          rejectPending(error);
        }
      });

      const requestRpc = (method, params) => {
        const id = nextId++;
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          try {
            child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
          } catch (error) {
            pending.delete(id);
            reject(error);
          }
        });
      };

      const nextNotification = () => {
        if (notifications.length > 0) {
          return {
            promise: Promise.resolve(notifications.shift()),
            cancel() {},
          };
        }
        let waiter;
        const promise = new Promise((resolve) => {
          waiter = { resolve };
          notificationWaiters.push(waiter);
        });
        return {
          promise,
          cancel() {
            const index = notificationWaiters.indexOf(waiter);
            if (index >= 0) notificationWaiters.splice(index, 1);
          },
        };
      };

      const abort = () => {
        if (!closed) child.kill("SIGTERM");
      };
      timer = setTimeout(abort, timeoutMs);
      try {
        yield { type: "block-start", index: 0, blockType: "text" };
        const initialize = await requestRpc("initialize", {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: true,
          },
        });
        const authMethods = new Set((initialize.authMethods ?? []).map((method) => method?.id).filter(Boolean));
        const methodId = resolvedEnv.XAI_API_KEY && authMethods.has("xai.api_key")
          ? "xai.api_key"
          : authMethods.has("cached_token") ? "cached_token" : null;
        if (!methodId) {
          const error = new Error(`${providerId} ACP has no usable authentication method`);
          error.code = "AUTH_REQUIRED";
          throw error;
        }
        await requestRpc("authenticate", { methodId, _meta: { headless: true } });
        const session = await requestRpc("session/new", {
          cwd: context.cwd ?? cwd ?? process.cwd(),
          mcpServers: [],
        });
        const sessionId = session.sessionId;
        if (!sessionId) throw new Error(`${providerId} ACP did not return a session id`);
        if (typeof request.model === "string" && request.model.length > 0) {
          await requestRpc("session/set_model", { sessionId, modelId: request.model });
        }
        if (typeof request.reasoningEffort === "string" && request.reasoningEffort.length > 0) {
          // ACP providers expose reasoning as a session config in different
          // versions. Keep it in the prompt metadata only when the provider
          // has no generic setter; model selection remains native above.
        }

        const promptResponse = requestRpc("session/prompt", { sessionId, prompt });
        let text = "";
        let finished = false;
        while (!finished) {
          const notification = nextNotification();
          const event = await Promise.race([
            promptResponse.then((result) => ({ type: "response", result })),
            notification.promise.then((message) => ({ type: "notification", message })),
          ]);
          if (event.type === "response") {
            notification.cancel();
            const stopReason = String(event.result?.stopReason ?? "stop").toLowerCase();
            if (["error", "failed", "cancelled"].includes(stopReason)) {
              const error = new Error(`${providerId} ACP request did not complete`);
              error.code = "UPSTREAM_ERROR";
              error.detail = event.result;
              throw error;
            }
            const usage = acpUsage(event.result?.usage);
            if (usage) yield { type: "usage", usage };
            finished = true;
            continue;
          }
          const update = event.message?.params?.update;
          if (event.message?.method !== "session/update" || !update) continue;
          if (update.sessionUpdate !== "agent_message_chunk" || typeof update.content?.text !== "string") continue;
          const delta = appendDelta(text, update.content.text);
          if (!delta) continue;
          text += delta;
          yield { type: "text-delta", index: 0, text: delta };
        }
        yield { type: "block-end", index: 0, block: { type: "text", text } };
        yield { type: "finish", reason: { kind: "stop" } };
      } finally {
        clearTimeout(timer);
        reader.close();
        rejectPending(new Error(`${providerId} ACP transport closed`));
        if (!closed) child.kill("SIGTERM");
      }
    })();
  };
}

export const cliAgentTransportConstants = Object.freeze({
  defaultOutputFormat: "stream-json",
});
