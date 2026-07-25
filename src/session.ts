import fs from "node:fs/promises";
import path from "node:path";
import { defaultSessionFile } from "./config.js";
import type { MainSession } from "./types.js";

export async function loadSession(file = defaultSessionFile): Promise<MainSession | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as MainSession;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function saveSession(session: MainSession, file = defaultSessionFile): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(session, null, 2), { mode: 0o600 });
  await fs.rename(temporary, file);
  await fs.chmod(file, 0o600);
}

export async function clearSession(file = defaultSessionFile): Promise<void> {
  try {
    await fs.unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
