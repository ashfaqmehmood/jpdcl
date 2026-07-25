import makeFetchCookie from "fetch-cookie";
import { CookieJar } from "tough-cookie";

export class CookieHttpClient {
  readonly jar: CookieJar;
  readonly fetch: typeof globalThis.fetch;

  constructor(serializedCookies?: string) {
    this.jar = serializedCookies
      ? CookieJar.deserializeSync(JSON.parse(serializedCookies))
      : new CookieJar();
    this.fetch = makeFetchCookie(globalThis.fetch, this.jar) as typeof globalThis.fetch;
  }

  serialize(): string {
    return JSON.stringify(this.jar.serializeSync());
  }
}
export function basicAuth(value: string): string {
  return `Basic ${Buffer.from(value, "utf8").toString("base64")}`;
}

export function buildUrl(
  baseUrl: string,
  path: string,
  params: Record<string, string | number | boolean | null | undefined> = {},
): string {
  let resolved = path;
  const unused = { ...params };
  for (const [key, rawValue] of Object.entries(params)) {
    const marker = `{${key}}`;
    if (resolved.includes(marker)) {
      if (rawValue === undefined || rawValue === null) {
        throw new Error(`Missing required URL parameter: ${key}`);
      }
      resolved = resolved.replaceAll(marker, encodeURIComponent(String(rawValue)));
      delete unused[key];
    }
  }
  const missing = [...resolved.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
  if (missing.length) throw new Error(`Missing required URL parameter(s): ${missing.join(", ")}`);

  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(resolved.replace(/^\//, ""), base);
  for (const [key, value] of Object.entries(unused)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}
