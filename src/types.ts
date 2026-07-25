export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface PortalResponse<T = unknown> {
  status?: boolean | number | string;
  message?: string;
  data?: T;
  [key: string]: unknown;
}

export interface MainSession {
  version: 1;
  createdAt: string;
  updatedAt: string;
  cookies: string;
  loginId?: string;
  primaryAccountId?: string;
  consumerCode?: string;
  user?: Record<string, unknown>;
  smart?: {
    token: string;
    baseUrl: string;
    appUrl?: string;
    tenantId?: string;
    accountId?: string;
    meterNumber?: string;
    userId?: string;
    expiresAt?: string;
    accountScoped?: boolean;
  };
}

export interface EndpointDefinition {
  portal: "main" | "smart" | "ledger";
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  encrypted?: boolean;
  auth: "public" | "public-basic" | "main-session" | "smart-bearer" | "smart-admin" | "external-basic";
  mutation?: boolean;
  binary?: boolean;
  dataClass?: "observed" | "derived" | "advisory" | "configuration" | "transactional";
  description: string;
  parameters?: string[];
  bodyExample?: Record<string, unknown>;
}

export interface RequestOptions {
  params?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
}
