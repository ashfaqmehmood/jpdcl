import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const output = path.join(root, "dist");
fs.rmSync(output, { recursive: true, force: true });

const compiler = path.join(root, "node_modules", "typescript", "bin", "tsc");
const result = spawnSync(process.execPath, [compiler, "-p", "tsconfig.build.json"], {
  cwd: root,
  stdio: "inherit",
});
if (result.status !== 0) process.exit(result.status ?? 1);

for (const name of ["launcher.js", "cli.js", "mcp-stdio.js", "server.js"]) {
  try { fs.chmodSync(path.join(output, name), 0o755); } catch { /* Windows/npm shims do not need chmod. */ }
}
