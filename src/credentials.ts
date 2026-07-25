import { config as loadDotEnv } from "dotenv";
import fs from "node:fs/promises";
import path from "node:path";

let loadedEnv: Record<string, string> | undefined;
let credentialsExistedBeforeDotEnv = false;
let dotenvLoaded = false;

function configuredEnvFile(): string {
  return process.env.JPDCL_ENV_FILE
    ? path.resolve(process.env.JPDCL_ENV_FILE)
    : path.resolve(process.cwd(), ".env");
}

function ensureDotEnvLoaded(): void {
  if (dotenvLoaded) return;
  credentialsExistedBeforeDotEnv = Boolean(process.env.JPDCL_LOGIN_ID && process.env.JPDCL_PASSWORD);
  loadedEnv = loadDotEnv({ path: configuredEnvFile(), override: false, quiet: true }).parsed;
  dotenvLoaded = true;
}

export interface Credentials {
  loginId: string;
  password: string;
  source: "environment" | "dotenv" | "oauth";
}

export async function resolveCredentials(): Promise<Credentials | undefined> {
  ensureDotEnvLoaded();
  const loginId = process.env.JPDCL_LOGIN_ID;
  const password = process.env.JPDCL_PASSWORD;
  if (!loginId || !password) return undefined;
  const loadedFromDotEnv = !credentialsExistedBeforeDotEnv
    && loadedEnv?.JPDCL_LOGIN_ID === loginId
    && loadedEnv?.JPDCL_PASSWORD === password;
  return {
    loginId,
    password,
    source: loadedFromDotEnv ? "dotenv" : "environment",
  };
}

export async function storeEnvCredentials(
  loginId: string,
  password: string,
  targetFile = configuredEnvFile(),
): Promise<string> {
  const absoluteTarget = path.resolve(targetFile);
  await fs.mkdir(path.dirname(absoluteTarget), { recursive: true, mode: 0o700 });

  let existing = "";
  try {
    existing = await fs.readFile(absoluteTarget, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const kept = existing
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:export\s+)?JPDCL_(?:LOGIN_ID|PASSWORD)\s*=/.test(line));
  while (kept.length && !kept.at(-1)?.trim()) kept.pop();
  const credentials = [
    `JPDCL_LOGIN_ID=${JSON.stringify(loginId)}`,
    `JPDCL_PASSWORD=${JSON.stringify(password)}`,
  ];
  const content = [...kept, ...(kept.length ? [""] : []), ...credentials, ""].join("\n");
  await fs.writeFile(absoluteTarget, content, { mode: 0o600 });
  await fs.chmod(absoluteTarget, 0o600);

  process.env.JPDCL_LOGIN_ID = loginId;
  process.env.JPDCL_PASSWORD = password;
  loadedEnv = { ...loadedEnv, JPDCL_LOGIN_ID: loginId, JPDCL_PASSWORD: password };
  credentialsExistedBeforeDotEnv = false;
  dotenvLoaded = true;
  return absoluteTarget;
}

export async function deleteEnvCredentials(targetFile = configuredEnvFile()): Promise<boolean> {
  const absoluteTarget = path.resolve(targetFile);
  let existing: string;
  try {
    existing = await fs.readFile(absoluteTarget, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const lines = existing.split(/\r?\n/);
  const filtered = lines.filter((line) => !/^\s*(?:export\s+)?JPDCL_(?:LOGIN_ID|PASSWORD)\s*=/.test(line));
  const removed = filtered.length !== lines.length;
  if (!removed) return false;
  const remaining = filtered.join("\n").replace(/^\s+|\s+$/g, "");
  if (remaining) {
    await fs.writeFile(absoluteTarget, `${remaining}\n`, { mode: 0o600 });
    await fs.chmod(absoluteTarget, 0o600);
  } else {
    await fs.unlink(absoluteTarget);
  }
  delete process.env.JPDCL_LOGIN_ID;
  delete process.env.JPDCL_PASSWORD;
  return true;
}

export async function credentialStatus(): Promise<{
  automaticRelogin: boolean;
  source?: Credentials["source"];
  envFile?: string;
}> {
  const credentials = await resolveCredentials();
  return {
    automaticRelogin: Boolean(credentials),
    source: credentials?.source,
    envFile: credentials?.source === "dotenv" ? configuredEnvFile() : undefined,
  };
}
