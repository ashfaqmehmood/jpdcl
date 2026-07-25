import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OAuthStore } from "./oauth-store.js";

type StoredValues = Record<string, unknown>;
type ExpiringState = { expiresAt?: number; grantId?: string };

/** Persistent single-instance OAuth storage for Node.js hosting. */
export class FileOAuthStore implements OAuthStore {
  private values: StoredValues | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filename: string) {}

  async get<T>(key: string): Promise<T | undefined> {
    return this.exclusive(async () => {
      const values = await this.load();
      const value = values[key] as T | undefined;
      if (!isExpired(value)) return value;
      delete values[key];
      await this.persist(values);
      return undefined;
    });
  }

  async put<T>(key: string, value: T): Promise<void> {
    await this.exclusive(async () => {
      const values = await this.load();
      values[key] = value;
      await this.persist(values);
    });
  }

  async consume<T>(key: string): Promise<T | undefined> {
    return this.exclusive(async () => {
      const values = await this.load();
      const value = values[key] as T | undefined;
      delete values[key];
      await this.persist(values);
      return isExpired(value) ? undefined : value;
    });
  }

  async delete(key: string): Promise<void> {
    await this.exclusive(async () => {
      const values = await this.load();
      if (!(key in values)) return;
      delete values[key];
      await this.persist(values);
    });
  }

  async revokeGrant(grantId: string): Promise<void> {
    await this.exclusive(async () => {
      const values = await this.load();
      let changed = false;
      for (const [key, raw] of Object.entries(values)) {
        if (key === `grant:${grantId}` || asExpiring(raw)?.grantId === grantId) {
          delete values[key];
          changed = true;
        }
      }
      if (changed) await this.persist(values);
    });
  }

  private async load(): Promise<StoredValues> {
    if (this.values) return this.values;
    try {
      const parsed = JSON.parse(await readFile(this.filename, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("OAuth state file must contain a JSON object");
      this.values = parsed as StoredValues;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "ENOENT") throw error;
      this.values = {};
    }
    return this.values;
  }

  private async persist(values: StoredValues): Promise<void> {
    const directory = path.dirname(this.filename);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(values), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.filename);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function asExpiring(value: unknown): ExpiringState | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ExpiringState : undefined;
}

function isExpired(value: unknown): boolean {
  const expiresAt = asExpiring(value)?.expiresAt;
  return typeof expiresAt === "number" && expiresAt <= Date.now();
}
