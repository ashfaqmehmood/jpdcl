import os from "node:os";
import path from "node:path";

export const MAIN_API_URL = "https://mob.jpdcl.co.in/WSSJPDCL/JWTAUTHENC/API";
export const SMART_API_URL = "https://cp.rdssjpdcl.com/api";
export const PORTAL_BASIC = "portal:portal123";
export const LOGIN_CREDENTIAL_HEADER = "mhgj70aizasybty01ob6mfvqoh0fj6rwvjluukcw8mjr04pkjh";

export const defaultSessionFile = process.env.JPDCL_SESSION_FILE
  ? path.resolve(process.env.JPDCL_SESSION_FILE)
  : path.join(os.homedir(), ".jpdcl", "session.json");

export function mutationsEnabled(): boolean {
  return process.env.JPDCL_ENABLE_MUTATIONS?.toLowerCase() === "true";
}
