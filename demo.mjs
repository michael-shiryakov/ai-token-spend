// Runs the dashboard in demo mode: no API keys needed, all provider requests are mocked
// with realistic sample data. Same ATS_MOCK_MODE flag used by the packaged demo .app builds.
// Spawned as a real `node server.mjs` process (not imported) so server.mjs's own
// entry-point detection and relaunch-on-setup logic behave exactly as they do for `npm start`.
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

// A prior demo session that was killed rather than quit cleanly (see below) can leave its
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A submitted setup screen makes server.mjs relaunch itself as a *replacement* process
// before the one we spawned below exits — checking right away would race its startup and
// misread "not bound yet" as "session over," so this requires two clean reads a beat apart
// before believing it.
async function confirmReallyStopped() {
  if (await anyDemoPortTaken()) return false;
  await sleep(600);
  return !(await anyDemoPortTaken());
}

const serverPath = join(here, "server.mjs");
const child = spawn(process.execPath, [serverPath], {
  stdio: "inherit",
  env: { ...process.env, ATS_MOCK_MODE: "1" },
});

// Submitting the setup screen makes server.mjs relaunch itself as a *detached* replacement
// process so it can survive the packaged .app's own restart — which means the process we
// spawned above can exit here while the real demo server keeps running under a new PID.
// Keep polling until every port it could be on actually frees up before restoring anything.
child.on("exit", async () => {
  await sleep(600);
  while (!(await confirmReallyStopped())) await sleep(500);
  restoreRealEnv();
  process.exit(0);
});

// Ctrl+C reaches this wrapper and the pre-setup child directly, but not a relaunched
// detached replacement (different process group) — give it a few seconds to see whether
// the port actually frees up before giving up and handing the terminal back. If it's still
// running, leave the backup in place rather than guessing; the check above picks it back
// up next time this is run.
async function handleShutdownSignal() {
  const deadline = Date.now() + 3000;
  let stopped = false;
  while (Date.now() < deadline) {
    if ((stopped = await confirmReallyStopped())) break;
    await sleep(200);
  }
  if (stopped) restoreRealEnv();
  process.exit(0);
}
process.on("SIGINT", handleShutdownSignal);
process.on("SIGTERM", handleShutdownSignal);
