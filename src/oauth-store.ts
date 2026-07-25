export interface OAuthStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  consume<T>(key: string): Promise<T | undefined>;
  delete(key: string): Promise<void>;
  revokeGrant(grantId: string): Promise<void>;
}

interface DurableObjectStorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string | string[]): Promise<boolean | number>;
  list<T>(): Promise<Map<string, T>>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
}

interface DurableObjectStateLike {
  storage: DurableObjectStorageLike;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

interface DurableObjectStubLike {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

type StateCommand =
  | { op: "get"; key: string }
  | { op: "put"; key: string; value: unknown }
  | { op: "consume"; key: string }
  | { op: "delete"; key: string }
  | { op: "revokeGrant"; grantId: string };

type ExpiringState = { expiresAt?: number; grantId?: string };

export class DurableOAuthStore implements OAuthStore {
  private readonly stub: DurableObjectStubLike;

  constructor(namespace: DurableObjectNamespaceLike) {
    this.stub = namespace.get(namespace.idFromName("jpdcl-oauth"));
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.call<T>({ op: "get", key });
  }

  async put<T>(key: string, value: T): Promise<void> {
    await this.call({ op: "put", key, value });
  }

  async consume<T>(key: string): Promise<T | undefined> {
    return this.call<T>({ op: "consume", key });
  }

  async delete(key: string): Promise<void> {
    await this.call({ op: "delete", key });
  }

  async revokeGrant(grantId: string): Promise<void> {
    await this.call({ op: "revokeGrant", grantId });
  }

  private async call<T = unknown>(command: StateCommand): Promise<T | undefined> {
    const response = await this.stub.fetch("https://oauth-state.internal/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
    });
    if (!response.ok) throw new Error(`OAuth state operation failed with HTTP ${response.status}`);
    const payload = await response.json() as { value?: T };
    return payload.value;
  }
}

export class MemoryOAuthStore implements OAuthStore {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.values.get(key) as T | undefined;
    if (isExpired(value)) {
      this.values.delete(key);
      return undefined;
    }
    return value;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async consume<T>(key: string): Promise<T | undefined> {
    const value = await this.get<T>(key);
    this.values.delete(key);
    return value;
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async revokeGrant(grantId: string): Promise<void> {
    for (const [key, raw] of this.values) {
      const value = asExpiring(raw);
      if (key === `grant:${grantId}` || value?.grantId === grantId) this.values.delete(key);
    }
  }
}

export class OAuthState {
  constructor(private readonly state: DurableObjectStateLike) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
    let command: StateCommand;
    try {
      command = await request.json() as StateCommand;
    } catch {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }

    return this.state.blockConcurrencyWhile(async () => {
      switch (command.op) {
        case "get": {
          const value = await this.state.storage.get(command.key);
          if (isExpired(value)) {
            await this.state.storage.delete(command.key);
            return Response.json({});
          }
          return Response.json({ value });
        }
        case "put":
          await this.state.storage.put(command.key, command.value);
          await this.scheduleCleanup(command.value);
          return Response.json({ ok: true });
        case "consume": {
          const value = await this.state.storage.get(command.key);
          await this.state.storage.delete(command.key);
          return Response.json(isExpired(value) ? {} : { value });
        }
        case "delete":
          await this.state.storage.delete(command.key);
          return Response.json({ ok: true });
        case "revokeGrant": {
          const entries = await this.state.storage.list<ExpiringState>();
          const keys = [...entries]
            .filter(([key, value]) => key === `grant:${command.grantId}` || value?.grantId === command.grantId)
            .map(([key]) => key);
          if (keys.length) await this.state.storage.delete(keys);
          return Response.json({ ok: true });
        }
      }
    });
  }

  async alarm(): Promise<void> {
    await this.state.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const entries = await this.state.storage.list<ExpiringState>();
      const expired: string[] = [];
      let nextExpiry: number | undefined;
      for (const [key, value] of entries) {
        if (typeof value?.expiresAt !== "number") continue;
        if (value.expiresAt <= now) expired.push(key);
        else nextExpiry = Math.min(nextExpiry ?? value.expiresAt, value.expiresAt);
      }
      if (expired.length) await this.state.storage.delete(expired);
      if (nextExpiry !== undefined) await this.state.storage.setAlarm(nextExpiry);
    });
  }

  private async scheduleCleanup(value: unknown): Promise<void> {
    const expiresAt = asExpiring(value)?.expiresAt;
    if (typeof expiresAt !== "number") return;
    const existing = await this.state.storage.getAlarm();
    if (existing === null || expiresAt < existing) await this.state.storage.setAlarm(expiresAt);
  }
}

function asExpiring(value: unknown): ExpiringState | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as ExpiringState
    : undefined;
}

function isExpired(value: unknown): boolean {
  const expiresAt = asExpiring(value)?.expiresAt;
  return typeof expiresAt === "number" && expiresAt <= Date.now();
}
