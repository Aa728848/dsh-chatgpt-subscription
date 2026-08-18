import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 30_000;
const LOCK_STALE_MS = 120_000;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireFileLock(filePath) {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });

  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid}\n`, "utf8");
      } catch (error) {
        await handle.close().catch(() => {});
        await rm(lockPath, { force: true }).catch(() => {});
        throw error;
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await handle.close().catch(() => {});
        await rm(lockPath, { force: true }).catch(() => {});
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const metadata = await stat(lockPath);
        if (Date.now() - metadata.mtimeMs > LOCK_STALE_MS) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch (lockError) {
        if (lockError?.code !== "ENOENT") throw lockError;
        continue;
      }
      if (Date.now() >= deadline) {
        const timeout = new Error(`Timed out waiting for state file lock: ${filePath}`);
        timeout.code = "ELOCKTIMEOUT";
        throw timeout;
      }
      await delay(LOCK_RETRY_MS);
    }
  }
}

async function withFileLock(filePath, operation) {
  const release = await acquireFileLock(filePath);
  try {
    return await operation();
  } finally {
    await release();
  }
}

export function defaultDockyardHome({ env = process.env, home = homedir() } = {}) {
  return env.DOCKYARD_DSH_HOME || join(home, ".dockyard-dsh");
}

export function defaultDockyardStatePath(options = {}) {
  return join(defaultDockyardHome(options), "state.json");
}

function emptyState() {
  return {
    schema: 1,
    pools: {},
    updatedAt: null,
  };
}

export class JsonStateStore {
  constructor({ filePath, home, env } = {}) {
    this.filePath = filePath ?? defaultDockyardStatePath({ home, env });
  }

  async load() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      return {
        ...emptyState(),
        ...parsed,
        pools: parsed?.pools && typeof parsed.pools === "object" ? parsed.pools : {},
      };
    } catch (error) {
      if (error?.code === "ENOENT") return emptyState();
      if (error instanceof SyntaxError) {
        // A corrupt state file must not brick the whole plugin at boot.
        // Archive the broken file and fall back to a fresh empty state so a
        // later save can rebuild the snapshot from the live account pool.
        const archivePath = `${this.filePath}.corrupted.${Date.now()}`;
        await rename(this.filePath, archivePath).catch(() => {});
        return emptyState();
      }
      throw error;
    }
  }

  async save(state) {
    return withFileLock(this.filePath, () => this.#write(state));
  }

  async update(mutator) {
    if (typeof mutator !== "function") throw new TypeError("State update mutator must be a function");
    return withFileLock(this.filePath, async () => {
      const current = await this.load();
      const next = await mutator(current);
      return this.#write(next);
    });
  }

  async #write(state) {
    const next = {
      ...emptyState(),
      ...state,
      updatedAt: new Date().toISOString(),
    };
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
    let committed = false;
    try {
      await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      await rename(tempPath, this.filePath);
      committed = true;
      return next;
    } finally {
      if (!committed) await rm(tempPath, { force: true }).catch(() => {});
    }
  }
}
