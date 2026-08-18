import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KEYCHAIN_SERVICE = "com.dockyard-dsh.credentials";
const SWIFT_BIN = "/usr/bin/swift";
const KEYCHAIN_HELPER = join(dirname(fileURLToPath(import.meta.url)), "macos-keychain-helper.swift");

function stableKey(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function runKeychainHelper(request, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const child = spawn(SWIFT_BIN, [KEYCHAIN_HELPER], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    let exitError = "";
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => {
      exitError += chunk.toString();
    });
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code) => {
      if (settled) return;
      if (code === 0) {
        try {
          finish(resolve, JSON.parse(Buffer.concat(stdout).toString("utf8")));
        } catch {
          finish(reject, new Error("macOS Keychain helper returned invalid data"));
        }
        return;
      }
      const error = new Error("macOS Keychain operation failed");
      error.code = code;
      error.detail = exitError.replace(/\s+/g, " ").trim().slice(0, 300);
      finish(reject, error);
    });
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      const error = new Error("macOS Keychain operation timed out");
      error.code = "ETIMEDOUT";
      finish(reject, error);
    }, timeoutMs);
    child.stdin.write(JSON.stringify(request));
    child.stdin.end();
  });
}

export function createCredentialRef(providerId, accountId) {
  return `provider-secret://dsh-subscriptions/${providerId}/${stableKey(`${providerId}:${accountId}`)}`;
}

export class MemorySecretStore {
  #values = new Map();

  async read(ref) {
    return this.#values.get(ref) ?? null;
  }

  async write(ref, value) {
    this.#values.set(ref, structuredClone(value));
    return ref;
  }

  async delete(ref) {
    this.#values.delete(ref);
  }
}

/**
 * Non-macOS default. Keep the runtime bootable so a host credential service
 * can be attached later, but never persist provider secrets in process memory
 * implicitly. Tests and explicit local fixtures should inject MemorySecretStore
 * themselves.
 */
export class UnavailableSecretStore {
  constructor({ platform = process.platform } = {}) {
    this.platform = platform;
  }

  async read() {
    return null;
  }

  async write() {
    throw new Error(`Secure credential storage is unavailable on ${this.platform}; configure the host credential service`);
  }

  async delete() {}
}

export class MacOSKeychainStore {
  constructor({ service = KEYCHAIN_SERVICE } = {}) {
    this.service = service;
  }

  async read(ref) {
    try {
      const output = await runKeychainHelper({ operation: "read", service: this.service, account: ref, value: null });
      return output.found ? JSON.parse(output.value) : null;
    } catch (error) {
      throw error;
    }
  }

  async write(ref, value) {
    await runKeychainHelper({
      operation: "write",
      service: this.service,
      account: ref,
      value: JSON.stringify(value),
    });
    return ref;
  }

  async delete(ref) {
    await runKeychainHelper({ operation: "delete", service: this.service, account: ref, value: null });
  }
}

export function createDefaultSecretStore({ platform = process.platform } = {}) {
  if (platform !== "darwin") return new UnavailableSecretStore({ platform });
  return new MacOSKeychainStore();
}

export const secretStoreConstants = Object.freeze({
  keychainService: KEYCHAIN_SERVICE,
});
