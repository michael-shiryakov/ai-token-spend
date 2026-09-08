// Runs the dashboard in demo mode: no API keys needed, all provider requests are mocked
// with realistic sample data. Same ATS_MOCK_MODE flag used by the packaged demo .app builds.
// Spawned as a real `node server.mjs` process (not imported) so server.mjs's own
// entry-point detection behaves exactly as it does for `npm start`.
//
// Every run starts from onboarding and never remembers what you typed in: any existing
// .env (e.g. from `npm start`) is set aside for the duration of the demo and restored once
// the session is actually over, rather than being overwritten by whatever placeholder key
// gets typed in.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, renameSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, ".env");
const backupPath = join(here, ".env.demo-backup");
const BASE_PORT = Number(process.env.PORT) || 4173;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A prior demo session that was killed mid-relaunch (rare, but possible) can leave its
// real-env backup on disk without having restored it yet — in that case the backup, not
// today's .env, is the real config, so don't clobber it with another rename.
const hadRealEnv = existsSync(backupPath) || existsSync(envPath);
if (existsSync(backupPath)) {
  if (existsSync(envPath)) unlinkSync(envPath);
} else if (existsSync(envPath)) {
  renameSync(envPath, backupPath);
}

let restored = false;
function restoreRealEnv() {
  if (restored) return;
  restored = true;
  if (existsSync(envPath)) unlinkSync(envPath);
  if (hadRealEnv) renameSync(backupPath, envPath);
}

// server.mjs tries up to 10 ports in a row if the first is busy (see listenWithFallback),
// so "the demo is really over" means none of those are bound anymore.
function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}
async function anyDemoPortTaken() {
  for (let i = 0; i < 10; i++) {
    if (!(await isPortFree(BASE_PORT + i))) return true;
  }
  return false;
}

const serverPath = join(here, "server.mjs");
const child = spawn(process.execPath, [serverPath], {
  stdio: "inherit",
  env: { ...process.env, ATS_MOCK_MODE: "1" },
});

// Submitting the setup screen makes server.mjs relaunch itself (to load the freshly-written
// config cleanly) — the process spawned above exits and a replacement takes over the port
// almost immediately. Wait for that dust to settle, then confirm nothing is listening
// anymore before restoring your real .env, rather than restoring the instant this one exits.
let stopping = false;
async function waitUntilStoppedThenRestore() {
  if (stopping) return;
  stopping = true;
  await sleep(600);
  while (await anyDemoPortTaken()) await sleep(500);
  restoreRealEnv();
  process.exit(0);
}

child.on("exit", waitUntilStoppedThenRestore);
process.on("SIGINT", waitUntilStoppedThenRestore);
process.on("SIGTERM", waitUntilStoppedThenRestore);
