// Local backend for the AI token spend dashboard.
// Holds ANTHROPIC_ADMIN_KEY server-side and proxies the Claude Enterprise
// Analytics API so the browser never sees the key or calls api.anthropic.com
// directly (that endpoint has no CORS support anyway).
//
// Usage: node --env-file=.env server.mjs

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { isSea, getAsset } from "node:sea";

// Directory this app's own files (and its config file, if any) live in — the project
// source directory in dev, or the folder holding the double-clicked executable when
// packaged. import.meta.url is unavailable in a packaged build, so that branch never runs
// there (isSea() short-circuits the ternary before it's evaluated).
//
// Inside a .app bundle the binary actually lives at AppName.app/Contents/MacOS/binary —
// writing the user's .env there would mean modifying a signed bundle's contents after the
// fact (macOS can start treating a signed .app as "damaged" once its sealed resources
// change), so in that case ROOT resolves to the bundle's *parent* folder instead, matching
// where a user would naturally look for a stray config file next to the app icon.
function resolveRoot() {
  if (!isSea()) return fileURLToPath(new URL(".", import.meta.url));
  const execDir = dirname(process.execPath);
  const bundleMatch = execDir.match(/^(.*\.app)\/Contents\/MacOS$/);
  return bundleMatch ? dirname(bundleMatch[1]) : execDir;
}
const ROOT = resolveRoot();

// Icons used to be hand-flattened SVG strings baked directly into the ICONS maps below and
// into index.html itself — hard to browse or tweak as one-line strings buried in a huge
// file. Now sourced from real files under assets/icons/ instead, read once at startup (same
// "server.mjs needs a restart to see changes" rule as everything else in this file — only
// index.html itself is re-read fresh per request). Read from disk unconditionally, never
// from a SEA asset — there's no packaging pipeline in this repo (see HANDOFF.md), so a
// packaged build isn't a concern today; if one gets added back, assets/icons/ would need
// bundling too, the same way index.html already is.
const ICONS_DIR = join(ROOT, "assets", "icons");
function readIconFile(name) {
  return readFileSync(join(ICONS_DIR, `${name}.svg`), "utf8");
}

// Normalizes a plain single-color icon as downloaded from an icon site (hardcoded black/
// white fill or stroke, arbitrary pixel width/height, XML prolog/attribution comments/title/
// desc cruft) into this app's own convention: 1em-sized so a wrapping span's font-size
// controls scale, and currentColor so it inherits whatever button/text color surrounds it —
// matching every hand-authored icon already in the ICONS maps below.
function monochromeIconSvg(name) {
  return readIconFile(name)
    .replace(/<\?xml[^>]*\?>/, "")
    .replace(/<!--[^]*?-->/g, "")
    .replace(/<title>[^]*?<\/title>/g, "")
    .replace(/<desc>[^]*?<\/desc>/g, "")
    .replace(/<defs>[^]*?<\/defs>/g, "")
    .replace(/\swidth="[^"]*"/, ' width="1em"')
    .replace(/\sheight="[^"]*"/, ' height="1em"')
    .replace(/(fill|stroke)="#[0-9a-fA-F]+"/g, '$1="currentColor"')
    .replace(/\s+/g, " ")
    .trim();
}

// The source file draws the key lying flat/horizontal — the app has always shown it tilted
// (teeth pointing down-left, as if about to unlock something), via this same -35deg rotation
// around the file's own bow-of-the-key coordinates.
const KEY_ICON_SVG = monochromeIconSvg("key").replace(
  /^(<svg[^>]*>)([\s\S]*)(<\/svg>)$/,
  '$1<g transform="rotate(-35 9 16)">$2</g>$3',
);
const SEND_ICON_SVG = monochromeIconSvg("paper-plane");
const REPEAT_ICON_SVG = monochromeIconSvg("rotate");
const TEAMS_ICON_SVG = monochromeIconSvg("users");
const DOLLAR_ICON_SVG = monochromeIconSvg("dollar");
const OPENAI_LOGO_SVG = monochromeIconSvg("openai-light");
// Anthropic's mark keeps its real brand orange rather than currentColor — unlike the
// monochrome UI icons above, this one's color is the point, not something that should ever
// inherit surrounding text color.
const ANTHROPIC_LOGO_SVG = readIconFile("anthropic")
  .replace(/<\?xml[^>]*\?>/, "")
  .replace(/\swidth="[^"]*"/, ' width="1em"')
  .replace(/\sheight="[^"]*"/, ' height="1em"')
  .replace(/\s+/g, " ")
  .trim();

const MOSS_LOGO_SOURCE_SVG = readIconFile("moss-logo-v2");

// A favicon needs a compact square glyph, not the wide 79x19 wordmark the headers use (a
// browser tab squeezes it into ~16px either way, where the "moss" lettering would be
// illegible) — so this pulls out just the icon-mark path (the lone fill-rule="evenodd" one,
// no wordmark letters) and drops it onto a small rounded-square badge, echoing the badge
// treatment the dashboard header itself used before the header-unification pass.
const FAVICON_ICON_PATH_D = (() => {
  const match = MOSS_LOGO_SOURCE_SVG.match(
    /fill-rule="evenodd" clip-rule="evenodd" d="([^"]+)" fill="currentColor"/,
  );
  if (!match) throw new Error("moss-logo-v2.svg: icon-mark path not found");
  return match[1];
})();
const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
  '<rect width="24" height="24" rx="5" fill="#002414"/>' +
  `<path fill-rule="evenodd" clip-rule="evenodd" transform="translate(1,2.5)" d="${FAVICON_ICON_PATH_D}" fill="#ffffff"/>` +
  "</svg>";
// base64, not a URL-encoded data URI — sidesteps having to escape the quotes/#/whitespace an
// SVG string like this is full of.
const FAVICON_LINK_TAG = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,${Buffer.from(FAVICON_SVG).toString("base64")}" />`;

// Single-instance lock. Add/change/remove key no longer relaunches the process (see
// applyProviderKeys), so this mainly guards a simpler case now: a previous session's
// `npm start` left running (terminal/tab closed without stopping it first) still squatting
// the port. Left alone, each forgotten instance keeps its port forever and the next
// `npm start` just falls back to the next one, piling up over time. This file records
// whichever process last actually bound the port; startup uses it to stop that one first,
// so the port is always free again.
const PID_FILE = join(ROOT, ".server.pid");

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Best-effort sanity check before signaling a PID we didn't just spawn ourselves — makes
// sure a stale pidfile is still pointing at one of our own server processes, not some
// unrelated one that happens to have reused the PID since. `ps` isn't available on Windows;
// failing to confirm there just falls back to trusting the pidfile (it's ours, written only
// by this app, so the risk of a stale collision is low).
function looksLikeOurServer(pid) {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
    }).includes("server.mjs");
  } catch {
    return true;
  }
}

async function killStalePreviousInstance() {
  if (!existsSync(PID_FILE)) return;
  const pid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
  if (!pid || pid === process.pid) return;
  if (!isProcessAlive(pid) || !looksLikeOurServer(pid)) return;
  console.warn(
    `Stopping a previous instance of this app still running (pid ${pid})...`,
  );
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  for (let i = 0; i < 20 && isProcessAlive(pid); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

// Packaged (double-click) builds have no --env-file flag to rely on, so also look for a
// plain KEY=value config file sitting next to the app (ROOT, above) — this is what the
// in-browser setup page (see handleSetup below) writes after a non-technical user pastes
// their API keys in. In dev this just finds nothing until the setup flow is used there
// too, and --env-file=.env (see package.json) keeps doing the work as before.
function loadExternalConfig() {
  const configPath = join(ROOT, ".env");
  if (!existsSync(configPath)) return;
  for (const line of readFileSync(configPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!(key in process.env)) process.env[key] = trimmed.slice(eq + 1).trim();
  }
}
loadExternalConfig();

// Either provider key works on its own, or both together — the dashboard degrades to
// showing just the connected provider(s)' data rather than requiring a specific one.
// Mutable, not const: applyProviderKeys (below) updates these in place when a key is
// added/changed/removed, so the running process picks up the change immediately instead of
// needing a relaunch (see applyProviderKeys for the full reasoning).
let KEY = process.env.ANTHROPIC_ADMIN_KEY;
let ANTHROPIC_ENABLED = Boolean(KEY);
let OPENAI_KEY = process.env.OPENAI_ADMIN_KEY;
let OPENAI_ENABLED = Boolean(OPENAI_KEY);

// Shared with the client-side copy inside SETUP_CLIENT_SCRIPT (that one masks what the user
// just typed, before it's ever sent anywhere; this one masks an already-saved key server-side
// before it's embedded in the dashboard page — the real value must never reach the browser).
function maskKey(key) {
  if (key.length <= 17) return "••••••••" + key.slice(-4);
  return key.slice(0, 13) + "••••••••" + key.slice(-4);
}

// Rather than exiting, an unconfigured packaged build serves a setup page until at least one
// key is saved — a non-technical user double-clicking an app has no terminal to read an error
// in. A function, not a frozen boolean, since ANTHROPIC_ENABLED/OPENAI_ENABLED can now change
// live (see applyProviderKeys) without a relaunch — a cached boolean would go stale the first
// time a key is added or removed.
function isSetupMode() {
  return !ANTHROPIC_ENABLED && !OPENAI_ENABLED;
}
if (isSetupMode()) {
  console.warn(
    "No API keys configured — serving the setup page until at least one is saved.",
  );
} else if (!ANTHROPIC_ENABLED) {
  console.warn(
    "Missing ANTHROPIC_ADMIN_KEY — Anthropic sections of the dashboard will show zero/empty data.",
  );
} else if (!OPENAI_ENABLED) {
  console.warn(
    "Missing OPENAI_ADMIN_KEY — OpenAI sections of the dashboard will show zero/empty data.",
  );
}

const PORT = Number(process.env.PORT) || 4173;
const API_BASE = "https://api.anthropic.com/v1/organizations/analytics";
// Mutable like KEY/OPENAI_KEY above — reassigned by applyProviderKeys. Safe as default
// parameter values elsewhere (`headers = HEADERS`) because JS evaluates default parameters
// at call time, re-reading whatever HEADERS currently holds rather than freezing it at the
// callee's definition time.
let HEADERS = { "x-api-key": KEY, "anthropic-version": "2023-06-01" };
const OPENAI_API_BASE = "https://api.openai.com/v1/organization";
let OPENAI_HEADERS = { Authorization: `Bearer ${OPENAI_KEY}` };

// Applies a new set of provider keys to the *running* process — no relaunch. Used by both
// handleSetup (add/change a key) and handleRemoveKey (drop one). Older versions of this app
// wrote .env and then spawned a whole fresh process, because KEY/OPENAI_KEY/ANTHROPIC_ENABLED
// /OPENAI_ENABLED/HEADERS/OPENAI_HEADERS were frozen consts computed once at module load —
// that relaunch (OS process spawn + the single-instance pidfile-kill dance the new process
// ran on its own startup + the client polling HEAD / until it answered) was the actual source
// of "remove key" sometimes taking several seconds: a real process restart's timing varies,
// a synchronous variable reassignment's doesn't. Now .env is purely a cold-boot bootstrap
// file — read once at startup (loadExternalConfig, above) and written here so the *next* cold
// start picks up the change, but never read back while this process keeps running.
function applyProviderKeys(anthropicKey, openaiKey) {
  KEY = anthropicKey || "";
  OPENAI_KEY = openaiKey || "";
  ANTHROPIC_ENABLED = Boolean(KEY);
  OPENAI_ENABLED = Boolean(OPENAI_KEY);
  HEADERS = { "x-api-key": KEY, "anthropic-version": "2023-06-01" };
  OPENAI_HEADERS = { Authorization: `Bearer ${OPENAI_KEY}` };

  const lines = [];
  if (KEY) lines.push(`ANTHROPIC_ADMIN_KEY=${KEY}`);
  if (OPENAI_KEY) lines.push(`OPENAI_ADMIN_KEY=${OPENAI_KEY}`);
  const configPath = join(ROOT, ".env");
  // Synchronous and immediate, not deferred to "later" — a few bytes to a local file is
  // effectively instant, and doing it synchronously means two overlapping requests can't
  // interleave two partial writes (Node can't preempt this function mid-execution).
  if (lines.length) writeFileSync(configPath, lines.join("\n") + "\n");
  else if (existsSync(configPath)) unlinkSync(configPath);
  console.log(
    `.env updated: anthropic=${KEY ? "yes" : "no"}, openai=${OPENAI_KEY ? "yes" : "no"}`,
  );
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
};

// A build-time-only flag (never read from .env — see build-mac-demo.sh, which bakes this in
// via esbuild's --define at bundle time) that swaps every real fetchX for a mock-data
// generator returning realistic, deterministic sample data, and skips real key verification.
// Absent (undefined) in the normal dev/production build, so this is always false there.
const MOCK_MODE = process.env.ATS_MOCK_MODE === "1";

// Tiny deterministic PRNG (mulberry32) so mock data varies day-to-day like real data would,
// but stays stable across repeated views/reloads of the same range within a demo — unlike
// Math.random(), the same seed always produces the same sequence.
function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
// Derives a stable seed from a label (a metric name, day index, etc.) so unrelated mock
// series don't accidentally share the same random sequence and move in lockstep.
function seedFrom(label) {
  let h = 0;
  for (let i = 0; i < label.length; i++)
    h = (Math.imul(h, 31) + label.charCodeAt(i)) | 0;
  return h >>> 0;
}
// A pseudo-random value in [min, max), stable for a given (seriesName, calendar date) pair,
// with a gentle Mon-Fri-busier/weekend-quieter wobble so cost/usage mock series don't look
// like flat noise. Seeded off the actual calendar date, NOT a range-relative day index —
// two equal-length ranges (e.g. "this period" vs "previous period") each count days from 0,
// so seeding off that index would make every period look byte-identical to every other
// same-length period, current vs. previous included.
function mockDailyValue(seriesName, dayIndex, min, max, dateIso) {
  const rand = mulberry32(seedFrom(`${seriesName}:${dateIso.slice(0, 10)}`))();
  const weekday = new Date(dateIso).getUTCDay();
  const weekendDip = weekday === 0 || weekday === 6 ? 0.6 : 1;
  return (min + rand * (max - min)) * weekendDip;
}

// ---- Demo mode: mock data ----------------------------------------------------------------
// Fixed, deterministic sample org used only when MOCK_MODE is on. Guards live at the lowest
// shared choke point that's still shape-specific — fetchAllBuckets for the Anthropic
// cost_report/usage_report family (covers 6 call sites with one guard), and each remaining
// distinct endpoint (user costs/usage, OpenAI costs/usage, seats, skills, tool actions, RBAC
// names) individually. Every real aggregateX function then runs completely unmodified on top.

function mockDaysInRange(startingAt, endingAt) {
  const days = [];
  let t = new Date(startingAt).getTime();
  const end = new Date(endingAt).getTime();
  let i = 0;
  while (t < end) {
    days.push({ dateIso: new Date(t).toISOString(), dayIndex: i });
    t += DAY_MS;
    i++;
  }
  return days;
}

const MOCK_DIMENSION_POOLS = {
  product: ["Claude.ai", "API", "Claude Code"],
  model: ["claude-opus-4-1", "claude-sonnet-4-5", "claude-haiku-4-5"],
  token_type: [
    "uncached_input_tokens",
    "cache_read_input_tokens",
    "cache_creation.ephemeral_5m_input_tokens",
    "output_tokens",
  ],
  rbac_group_id: [
    "team-engineering",
    "team-support",
    "team-sales",
    "team-marketing",
    "team-finance",
  ],
  context_window: ["0-200K", "200K-1M"],
  inference_geo: ["global", "eu-west-1"],
  speed: ["standard", "fast"],
};
const MOCK_RBAC_GROUP_NAMES = {
  "team-engineering": "Engineering",
  "team-support": "Customer Support",
  "team-sales": "Sales",
  "team-marketing": "Marketing",
  "team-finance": "Finance",
};

function mockDimensionCombos(groupBy) {
  if (!groupBy || groupBy.length === 0) return [{}];
  let combos = [{}];
  for (const dim of groupBy) {
    const pool = MOCK_DIMENSION_POOLS[dim] ?? ["unspecified"];
    combos = combos.flatMap((c) => pool.map((val) => ({ ...c, [dim]: val })));
  }
  return combos;
}

// Shared by every cost_report/usage_report caller via fetchAllBuckets, below.
function mockCostReportBuckets(startingAt, endingAt, groupBy) {
  const combos = mockDimensionCombos(groupBy);
  return mockDaysInRange(startingAt, endingAt).map(({ dateIso, dayIndex }) => {
    const dayTotal = mockDailyValue("cost_total", dayIndex, 250, 850, dateIso);
    const results = combos.map((combo) => {
      const label = JSON.stringify(combo);
      const weight = mockDailyValue(
        `cost_combo:${label}`,
        dayIndex,
        0.4,
        1.4,
        dateIso,
      );
      const amountDollars = (dayTotal / combos.length) * weight;
      const requests = Math.max(
        1,
        Math.round(
          amountDollars *
            (8 +
              mulberry32(
                seedFrom(`cost_req:${label}:${dateIso.slice(0, 10)}`),
              )() *
                6),
        ),
      );
      return {
        ...combo,
        amount: (amountDollars * 100).toFixed(6),
        list_amount: (amountDollars * 100 * 1.18).toFixed(6),
        requests,
      };
    });
    return { starting_at: dateIso, results };
  });
}

function mockUsageReportBuckets(startingAt, endingAt, groupBy) {
  const combos = mockDimensionCombos(groupBy);
  return mockDaysInRange(startingAt, endingAt).map(({ dateIso, dayIndex }) => {
    const results = combos.map((combo) => {
      const label = JSON.stringify(combo);
      const uncached = Math.round(
        mockDailyValue(
          `usage_uncached:${label}`,
          dayIndex,
          200000,
          900000,
          dateIso,
        ) / combos.length,
      );
      const cacheRead = Math.round(
        uncached *
          (1.2 +
            mulberry32(
              seedFrom(`usage_cacheread:${label}:${dateIso.slice(0, 10)}`),
            )()),
      );
      return {
        ...combo,
        uncached_input_tokens: uncached,
        cache_read_input_tokens: cacheRead,
        cache_creation: {
          ephemeral_5m_input_tokens: Math.round(uncached * 0.15),
          ephemeral_1h_input_tokens: Math.round(uncached * 0.05),
        },
        output_tokens: Math.round(uncached * 0.35),
        requests: Math.max(1, Math.round(uncached / 4000)),
      };
    });
    return { starting_at: dateIso, results };
  });
}

// A small fixed roster shared across Anthropic and OpenAI person-level mocks, so the same
// people show up unified in the People tab instead of looking like two disjoint orgs.
const MOCK_PEOPLE = [
  { name: "Alex Kim", email: "alex.kim@acme.test" },
  { name: "Jordan Lee", email: "jordan.lee@acme.test" },
  { name: "Sam Patel", email: "sam.patel@acme.test" },
  { name: "Taylor Chen", email: "taylor.chen@acme.test" },
  { name: "Morgan Davis", email: "morgan.davis@acme.test" },
  { name: "Riley Nguyen", email: "riley.nguyen@acme.test" },
  { name: "Casey Brooks", email: "casey.brooks@acme.test" },
  { name: "Jamie Ortiz", email: "jamie.ortiz@acme.test" },
  { name: "Drew Sullivan", email: "drew.sullivan@acme.test" },
  { name: "Reese Campbell", email: "reese.campbell@acme.test" },
];

// Already in the final per-person shape fetchUserCostsChunk itself returns (its own
// toDollars mapping happens after the real fetch, so mocking here returns dollars directly).
function mockUserCostRows(startingAt, endingAt) {
  const days = Math.max(
    1,
    (new Date(endingAt).getTime() - new Date(startingAt).getTime()) / DAY_MS,
  );
  return MOCK_PEOPLE.map((p, i) => {
    const dailyRate = 3 + i * 2.2;
    const factor =
      0.7 +
      mulberry32(seedFrom(`person_cost:${p.email}:${startingAt}`))() * 0.6;
    const amount = dailyRate * days * factor;
    return {
      name: p.name,
      email: p.email,
      amount,
      listAmount: amount * 1.18,
      requests: Math.round(amount * 9),
    };
  });
}

// Already in the final Map<email, {...}> shape fetchUserUsageTotalsChunk itself returns.
function mockUserUsageRows(startingAt, endingAt) {
  const days = Math.max(
    1,
    (new Date(endingAt).getTime() - new Date(startingAt).getTime()) / DAY_MS,
  );
  const byEmail = new Map();
  MOCK_PEOPLE.forEach((p, i) => {
    const factor =
      0.7 +
      mulberry32(seedFrom(`person_usage:${p.email}:${startingAt}`))() * 0.6;
    const totalTokens = Math.round((5000 + i * 3000) * days * factor);
    byEmail.set(p.email, {
      cacheReadInputTokens: Math.round(totalTokens * 0.4),
      totalTokens,
    });
  });
  return byEmail;
}

function mockOpenAiCostBuckets(startingAtUnix, endingAtUnix, groupBy) {
  const DAY_S = 24 * 60 * 60;
  const buckets = [];
  let t = startingAtUnix;
  let dayIndex = 0;
  while (t < endingAtUnix) {
    const dateIso = new Date(t * 1000).toISOString();
    let results;
    if (groupBy?.includes("user_id")) {
      results = MOCK_PEOPLE.map((p) => ({
        user_email: p.email,
        amount: {
          value: mockDailyValue(
            `oai_user:${p.email}`,
            dayIndex,
            1,
            12,
            dateIso,
          ),
        },
      }));
    } else if (groupBy?.includes("project_id")) {
      const projects = [
        { id: "proj-support-bot", name: "Support Bot" },
        { id: "proj-internal-tools", name: "Internal Tools" },
        { id: "proj-marketing-copy", name: "Marketing Copy" },
      ];
      results = projects.map((proj) => ({
        project_id: proj.id,
        project_name: proj.name,
        amount: {
          value: mockDailyValue(
            `oai_project:${proj.id}`,
            dayIndex,
            5,
            60,
            dateIso,
          ),
        },
      }));
    } else {
      results = [
        {
          amount: {
            value: mockDailyValue("oai_total", dayIndex, 80, 320, dateIso),
          },
        },
      ];
    }
    buckets.push({ start_time: t, start_time_iso: dateIso, results });
    t += DAY_S;
    dayIndex++;
  }
  return buckets;
}

function mockOpenAiUsageBuckets(startingAtUnix, endingAtUnix) {
  const DAY_S = 24 * 60 * 60;
  const buckets = [];
  let t = startingAtUnix;
  let dayIndex = 0;
  while (t < endingAtUnix) {
    const dateIso = new Date(t * 1000).toISOString();
    const requests = Math.round(
      mockDailyValue("oai_requests", dayIndex, 400, 1600, dateIso),
    );
    buckets.push({
      start_time: t,
      start_time_iso: dateIso,
      results: [{ num_model_requests: requests }],
    });
    t += DAY_S;
    dayIndex++;
  }
  return buckets;
}

// Matches fetchActivitySummaries's own return value (already unwrapped from {summaries:[...]})
// — shapeActivitySummary/handleSeats run unmodified on top of this.
function mockActivitySummaries(startingDate) {
  const totalSeats = 42;
  const out = [];
  for (let i = 0; i < 14; i++) {
    const dateIso = new Date(
      new Date(startingDate).getTime() + i * DAY_MS,
    ).toISOString();
    const mau = Math.round(
      totalSeats * (0.55 + mockDailyValue("seats_mau", i, 0, 0.25, dateIso)),
    );
    out.push({
      starting_at: dateIso,
      assigned_seat_count: totalSeats,
      pending_invite_count: 3,
      daily_active_user_count: Math.round(mau * 0.4),
      weekly_active_user_count: Math.round(mau * 0.75),
      monthly_active_user_count: mau,
      daily_adoption_rate: (mau * 0.4 * 100) / totalSeats,
      weekly_adoption_rate: (mau * 0.75 * 100) / totalSeats,
      monthly_adoption_rate: (mau * 100) / totalSeats,
    });
  }
  return out;
}

// Matches fetchSkills's own return value (already mapped to its final {name, users, ...}
// shape, not raw API rows) — handleSkills' previous-period diffing runs unmodified on top.
const MOCK_SKILL_NAMES = [
  "docx",
  "pptx",
  "xlsx",
  "pdf-fill",
  "web-search",
  "code-interpreter",
];
function mockSkillRows(startingAt, limit) {
  return MOCK_SKILL_NAMES.slice(0, limit).map((name, i) => {
    const rand = mulberry32(seedFrom(`skill:${name}:${startingAt}`))();
    const invocations = Math.max(5, Math.round(400 - i * 50 + rand * 150));
    const overageSpend = invocations * (0.02 + i * 0.01);
    return {
      name,
      users: Math.max(1, Math.round(invocations / (3 + i))),
      invocations,
      listValue: overageSpend * 1.2,
      overageSpend,
    };
  });
}

// Matches fetchToolActionTotals's own return value (a Map, aggregated inline with no
// separate pure aggregator to reuse).
function mockToolActionTotals(startingAt) {
  return new Map(
    TOOL_ACTION_KEYS.map((key, i) => {
      const rand = mulberry32(seedFrom(`toolaction:${key}:${startingAt}`))();
      const accepted = Math.max(0, Math.round(80 + rand * 300 - i * 15));
      const rejected = Math.max(0, Math.round(accepted * (0.1 + rand * 0.15)));
      return [key, { accepted, rejected }];
    }),
  );
}

// Matches fetchRbacGroupNames's own return value (a Map).
function mockRbacGroupNames() {
  return new Map(Object.entries(MOCK_RBAC_GROUP_NAMES));
}

// Amounts come back as decimal strings in cents (e.g. "41280.000000" = $412.80).
export const toDollars = (s) => Number.parseFloat(s) / 100;

const cache = new Map();

// Anthropic's Analytics API caps requests at 60/min (confirmed via the
// anthropic-ratelimit-requests-limit response header). Wide date ranges get split into several
// ≤31-day chunks (see MAX_RANGE_DAYS below), and several dashboard cards load in parallel on a
// cold cache — together that can burst well past 60/min and 429. A small concurrency cap
// smooths the burst out instead of firing dozens of requests at once; retry-with-backoff is
// the safety net for whatever still gets rate-limited.
const MAX_CONCURRENT_REQUESTS = 6;
let activeRequests = 0;
const requestQueue = [];

function withConcurrencyLimit(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      activeRequests++;
      fn()
        .then(resolve, reject)
        .finally(() => {
          activeRequests--;
          const next = requestQueue.shift();
          if (next) next();
        });
    };
    if (activeRequests < MAX_CONCURRENT_REQUESTS) run();
    else requestQueue.push(run);
  });
}

async function cachedFetchJson(url, headers = HEADERS, attempt = 0) {
  const key = url.toString();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const response = await withConcurrencyLimit(() => fetch(url, { headers }));
  if (response.status === 429 && attempt < 6) {
    const retryAfterSec = Number(response.headers.get("retry-after")) || 3;
    await new Promise((r) => setTimeout(r, retryAfterSec * 1000 + 250));
    return cachedFetchJson(url, headers, attempt + 1);
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Analytics API ${response.status}: ${text}`);
  }
  const data = await response.json();
  cache.set(key, { at: Date.now(), data });
  return data;
}

// The Analytics API only has data back to a fixed org-wide start date (confirmed live:
// "data prior to 2026-01-01 is not available"). A wide range option (90/180/365 days, or a
// same-length "previous period" comparison) can ask for dates before that floor. Rather than
// letting the whole request 400, clamp starting_at to the floor and retry once, or — if the
// entire requested window predates the floor — return an empty result. Only for the RFC3339
// starting_at/ending_at endpoints (cost_report, usage_report, user_cost_report, user_usage_report);
// /users, /skills, /summaries use a different starting_date-only param and are handled separately.
async function cachedFetchJsonRanged(url, headers = HEADERS) {
  try {
    return await cachedFetchJson(url, headers);
  } catch (err) {
    const match =
      err instanceof Error &&
      err.message.match(/earliest:\s*(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/);
    if (!match) throw err;
    const floor = match[1];
    const startingAt = url.searchParams.get("starting_at");
    const endingAt = url.searchParams.get("ending_at");
    if (endingAt && endingAt <= floor) return { data: [], has_more: false };
    if (startingAt && startingAt < floor) {
      url.searchParams.set("starting_at", floor);
      return cachedFetchJson(url, headers);
    }
    throw err;
  }
}

// Same history-floor situation as cachedFetchJsonRanged, but /users and /skills are date-only
// (starting_date, not starting_at/ending_at) and phrase the error differently: "Data is only
// available from 2026-01-01 onwards." rather than "earliest: <RFC3339 timestamp>".
async function cachedFetchJsonDated(url, headers = HEADERS) {
  try {
    return await cachedFetchJson(url, headers);
  } catch (err) {
    const match =
      err instanceof Error &&
      err.message.match(/available from (\d{4}-\d{2}-\d{2})/);
    if (!match) throw err;
    const floor = match[1];
    const startingDate = url.searchParams.get("starting_date");
    if (startingDate && startingDate < floor) {
      url.searchParams.set("starting_date", floor);
      return cachedFetchJson(url, headers);
    }
    throw err;
  }
}

const daysAgoISO = (days) =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
const daysAgoUnix = (days) =>
  Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;

// Confirmed live: the Analytics API rejects any starting_at/ending_at request spanning more
// than 31 days ("date range must span at most 31 days") — this is a hard cap on the request's
// date SPAN, separate from `limit` (which only caps how many buckets come back per page). Wide
// range options (90/180/365 days) have to be split into sequential ≤31-day windows.
const MAX_RANGE_DAYS = 31;

export function chunkDateRange(startingAt, endingAt) {
  const end = new Date(endingAt).getTime();
  const chunks = [];
  let chunkStart = new Date(startingAt).getTime();
  while (chunkStart < end) {
    const chunkEnd = Math.min(
      chunkStart + MAX_RANGE_DAYS * 24 * 60 * 60 * 1000,
      end,
    );
    chunks.push([
      new Date(chunkStart).toISOString(),
      new Date(chunkEnd).toISOString(),
    ]);
    chunkStart = chunkEnd;
  }
  return chunks;
}

// Fetches every page of every ≤31-day chunk needed to cover [startingAt, endingAt) from a
// bucket_width=1d cost_report/usage_report-shaped endpoint, and concatenates the raw buckets
// in chronological order. Chunks run in parallel — each is an independent request.
async function fetchAllBuckets(path, startingAt, endingAt, groupBy = []) {
  // Single choke point for every cost_report/usage_report caller (fetchCostBuckets,
  // fetchCostByContextWindow, fetchCostByModelTokenType, fetchCostTotalsByDimension,
  // fetchUsageBuckets, fetchUsageGroupedBy, and handleTeams's direct calls) — one guard here
  // covers all of them, and every real aggregateX still runs unmodified on the mock buckets.
  if (MOCK_MODE) {
    return path === "cost_report"
      ? mockCostReportBuckets(startingAt, endingAt, groupBy)
      : mockUsageReportBuckets(startingAt, endingAt, groupBy);
  }
  const chunkResults = await Promise.all(
    chunkDateRange(startingAt, endingAt).map(async ([chunkStart, chunkEnd]) => {
      const url = new URL(`${API_BASE}/${path}`);
      url.searchParams.set("starting_at", chunkStart);
      url.searchParams.set("ending_at", chunkEnd);
      url.searchParams.set("bucket_width", "1d");
      url.searchParams.set("limit", "31");
      for (const dim of groupBy) url.searchParams.append("group_by[]", dim);

      const buckets = [];
      let page;
      do {
        if (page) url.searchParams.set("page", page);
        const data = await cachedFetchJsonRanged(url);
        buckets.push(...data.data);
        page = data.has_more ? data.next_page : null;
      } while (page);
      return buckets;
    }),
  );
  return chunkResults.flat();
}

// OpenAI's cost API bundles model + token type into one free-text string per
// row, e.g. "priority | gpt-5.6-sol, output, long context" or
// "gpt-4o-mini-2024-07-18, cached input" — unlike Anthropic's separate
// model/token_type fields. Verified against this org's real line items
// (67 distinct values, 66 parse cleanly); the one exception is non-model
// tool costs like "web search tool calls".
export function parseOpenAiLineItem(lineItem) {
  const m = lineItem.match(
    /^(?:priority \| )?(.+?), (input|output|cached input|cache writes)(?:, long context)?$/,
  );
  if (!m)
    return {
      model: "Other (tools)",
      tokenType: "other",
      priority: false,
      longContext: false,
    };
  return {
    model: m[1],
    tokenType: m[2],
    priority: lineItem.startsWith("priority | "),
    longContext: lineItem.endsWith(", long context"),
  };
}

// When Anthropic is disabled, this can't just return [] like the other leaf fetchers: its
// buckets are what handleCostSummary derives the whole response's shared day-by-day `labels`
// axis from (aggregateCostBuckets: labels = buckets.map(b => b.starting_at...)), and OpenAI's
// series then gets mapped onto those same labels. An empty array here would collapse the
// entire combined chart to nothing in OpenAI-only mode, not just hide the Anthropic line — so
// this synthesizes a correctly-dated, zero-valued bucket per day instead.
export function emptyDailyBuckets(startingAt, endingAt) {
  const days = [];
  let t = new Date(startingAt).getTime();
  const end = new Date(endingAt).getTime();
  while (t < end) {
    days.push({ starting_at: new Date(t).toISOString(), results: [] });
    t += DAY_MS;
  }
  return days;
}

async function fetchCostBuckets(startingAt, endingAt) {
  if (!ANTHROPIC_ENABLED) return emptyDailyBuckets(startingAt, endingAt);
  return fetchAllBuckets("cost_report", startingAt, endingAt, [
    "product",
    "model",
  ]);
}

export function aggregateCostBuckets(buckets) {
  const labels = buckets.map((b) => b.starting_at.slice(0, 10));
  const daily = [];
  const productTotals = new Map();
  const modelTotals = new Map();
  const productDaily = new Map();
  const modelDaily = new Map();
  const productDailyRequests = new Map();
  const modelDailyRequests = new Map();
  const totals = { spend: 0, listAmount: 0, requests: 0 };

  buckets.forEach((bucket, i) => {
    const day = { date: labels[i], spend: 0, listAmount: 0, requests: 0 };
    const dayProduct = new Map();
    const dayModel = new Map();

    for (const row of bucket.results) {
      const amount = toDollars(row.amount);
      const listAmount = toDollars(row.list_amount);
      const requests = row.requests ?? 0;

      day.spend += amount;
      day.listAmount += listAmount;
      day.requests += requests;

      if (row.product) {
        const t = productTotals.get(row.product) ?? {
          spend: 0,
          listAmount: 0,
          requests: 0,
        };
        t.spend += amount;
        t.listAmount += listAmount;
        t.requests += requests;
        productTotals.set(row.product, t);
        const d = dayProduct.get(row.product) ?? { spend: 0, requests: 0 };
        d.spend += amount;
        d.requests += requests;
        dayProduct.set(row.product, d);
      }
      if (row.model) {
        const t = modelTotals.get(row.model) ?? {
          spend: 0,
          listAmount: 0,
          requests: 0,
        };
        t.spend += amount;
        t.listAmount += listAmount;
        t.requests += requests;
        modelTotals.set(row.model, t);
        const d = dayModel.get(row.model) ?? { spend: 0, requests: 0 };
        d.spend += amount;
        d.requests += requests;
        dayModel.set(row.model, d);
      }
    }

    daily.push(day);
    totals.spend += day.spend;
    totals.listAmount += day.listAmount;
    totals.requests += day.requests;

    for (const [name, d] of dayProduct) {
      if (!productDaily.has(name)) {
        productDaily.set(name, new Array(buckets.length).fill(0));
        productDailyRequests.set(name, new Array(buckets.length).fill(0));
      }
      productDaily.get(name)[i] = d.spend;
      productDailyRequests.get(name)[i] = d.requests;
    }
    for (const [name, d] of dayModel) {
      if (!modelDaily.has(name)) {
        modelDaily.set(name, new Array(buckets.length).fill(0));
        modelDailyRequests.set(name, new Array(buckets.length).fill(0));
      }
      modelDaily.get(name)[i] = d.spend;
      modelDailyRequests.get(name)[i] = d.requests;
    }
  });

  const toSeries = (dailyMap, dailyRequestsMap, totalsMap) =>
    [...totalsMap.entries()]
      .sort((a, b) => b[1].spend - a[1].spend)
      .map(([name, t]) => ({
        name,
        spend: dailyMap.get(name) ?? new Array(daily.length).fill(0),
        requestsDaily:
          dailyRequestsMap.get(name) ?? new Array(daily.length).fill(0),
        totalSpend: t.spend,
        totalListAmount: t.listAmount,
        requests: t.requests,
      }));

  return {
    labels,
    daily,
    byProduct: toSeries(productDaily, productDailyRequests, productTotals),
    byModel: toSeries(modelDaily, modelDailyRequests, modelTotals),
    totals,
  };
}

async function fetchCostByContextWindow(startingAt, endingAt) {
  if (!ANTHROPIC_ENABLED) return [];
  return fetchAllBuckets("cost_report", startingAt, endingAt, [
    "context_window",
  ]);
}

function aggregateContextWindow(buckets) {
  const totals = new Map();
  const daily = new Map();

  buckets.forEach((bucket, i) => {
    for (const row of bucket.results) {
      const key = row.context_window ?? "unspecified";
      const amount = toDollars(row.amount);

      const t = totals.get(key) ?? { spend: 0, requests: 0 };
      t.spend += amount;
      t.requests += row.requests ?? 0;
      totals.set(key, t);

      if (!daily.has(key)) daily.set(key, new Array(buckets.length).fill(0));
      daily.get(key)[i] += amount;
    }
  });

  return [...totals.entries()]
    .sort((a, b) => b[1].spend - a[1].spend)
    .map(([name, t]) => ({
      name,
      spend: daily.get(name),
      totalSpend: t.spend,
      requests: t.requests,
    }));
}

// user_cost_report isn't bucketed by day — each row is already a per-person total for
// whatever range was queried, sorted by amount descending. Since the API caps a single
// request's date span at 31 days (see MAX_RANGE_DAYS), a wide range has to be split into
// chunks and the per-person totals summed back together by email, rather than concatenated
// the way daily buckets are.
async function fetchUserCostsChunk(startingAt, endingAt) {
  if (MOCK_MODE) return mockUserCostRows(startingAt, endingAt);
  const url = new URL(`${API_BASE}/user_cost_report`);
  url.searchParams.set("starting_at", startingAt);
  url.searchParams.set("ending_at", endingAt);
  url.searchParams.set("limit", "1000"); // this org has well under 1000 people — always fetch everyone per chunk

  const rows = [];
  let page;
  do {
    if (page) url.searchParams.set("page", page);
    const data = await cachedFetchJsonRanged(url);
    rows.push(...data.data);
    page = data.has_more ? data.next_page : null;
  } while (page);

  return rows.map((row) => ({
    name: row.actor?.name ?? row.actor?.email ?? "Unknown",
    email: row.actor?.email ?? null,
    amount: toDollars(row.amount),
    listAmount: toDollars(row.list_amount),
    requests: row.requests ?? 0,
  }));
}

async function fetchUserCosts(startingAt, endingAt, limit) {
  if (!ANTHROPIC_ENABLED) return [];
  const chunkRows = await Promise.all(
    chunkDateRange(startingAt, endingAt).map(([s, e]) =>
      fetchUserCostsChunk(s, e),
    ),
  );

  const byKey = new Map();
  for (const rows of chunkRows) {
    for (const row of rows) {
      const key = row.email ?? row.name;
      const acc = byKey.get(key);
      if (acc) {
        acc.amount += row.amount;
        acc.listAmount += row.listAmount;
        acc.requests += row.requests;
      } else {
        byKey.set(key, { ...row });
      }
    }
  }

  return [...byKey.values()]
    .sort((a, b) => b.amount - a.amount)
    .slice(0, limit);
}

// OpenAI's cost API uses unix-second start_time/end_time (not RFC 3339) and
// plain decimal USD amounts (not cents-as-strings like Anthropic).
async function fetchOpenAiCostBuckets(startingAtUnix, endingAtUnix, groupBy) {
  if (!OPENAI_ENABLED) return [];
  // Checked after !OPENAI_ENABLED, not before — mock data should only appear for whichever
  // provider(s) the demo actually "connected" a key for, so the real single/dual-provider
  // nudge UI (see the connect-banner/KPI action tile) still demos correctly.
  if (MOCK_MODE)
    return mockOpenAiCostBuckets(startingAtUnix, endingAtUnix, groupBy);
  const url = new URL(`${OPENAI_API_BASE}/costs`);
  url.searchParams.set("start_time", String(startingAtUnix));
  url.searchParams.set("end_time", String(endingAtUnix));
  url.searchParams.set("bucket_width", "1d");
  url.searchParams.set("limit", "31");
  for (const dim of groupBy) url.searchParams.append("group_by[]", dim);

  const buckets = [];
  let page;
  do {
    if (page) url.searchParams.set("page", page);
    const data = await cachedFetchJson(url, OPENAI_HEADERS);
    buckets.push(...data.data);
    page = data.has_more ? data.next_page : null;
  } while (page);

  return buckets;
}

// Anthropic and OpenAI don't bucket the same nominal date range into the
// same number of daily buckets (e.g. a 7-day Anthropic window yields 7
// buckets; the equivalent OpenAI window yields 8, since OpenAI's bucket
// boundaries land differently relative to "now"). Keying by date string
// instead of array index avoids misaligning the two providers' series.
function aggregateOpenAiCostBuckets(buckets) {
  const dailyByDate = new Map();
  let totalSpend = 0;

  for (const bucket of buckets) {
    const date = (
      bucket.start_time_iso ?? new Date(bucket.start_time * 1000).toISOString()
    ).slice(0, 10);
    for (const row of bucket.results) {
      const amount = row.amount?.value ?? 0;
      dailyByDate.set(date, (dailyByDate.get(date) ?? 0) + amount);
      totalSpend += amount;
    }
  }

  return { dailyByDate, totalSpend };
}

// The Costs API has no request-count field at all (confirmed live — a cost
// result only carries `amount`) — request counts for OpenAI only exist on
// the separate Usage API's `num_model_requests` field. Same bucket/pagination
// shape as fetchOpenAiCostBuckets, just a different endpoint and metric.
async function fetchOpenAiUsageBuckets(startingAtUnix, endingAtUnix) {
  if (!OPENAI_ENABLED) return [];
  if (MOCK_MODE) return mockOpenAiUsageBuckets(startingAtUnix, endingAtUnix);
  const url = new URL(`${OPENAI_API_BASE}/usage/completions`);
  url.searchParams.set("start_time", String(startingAtUnix));
  url.searchParams.set("end_time", String(endingAtUnix));
  url.searchParams.set("bucket_width", "1d");
  url.searchParams.set("limit", "31");

  const buckets = [];
  let page;
  do {
    if (page) url.searchParams.set("page", page);
    const data = await cachedFetchJson(url, OPENAI_HEADERS);
    buckets.push(...data.data);
    page = data.has_more ? data.next_page : null;
  } while (page);

  return buckets;
}

function aggregateOpenAiUsageBuckets(buckets) {
  const dailyByDate = new Map();
  let totalRequests = 0;

  for (const bucket of buckets) {
    const date = (
      bucket.start_time_iso ?? new Date(bucket.start_time * 1000).toISOString()
    ).slice(0, 10);
    for (const row of bucket.results) {
      const requests = row.num_model_requests ?? 0;
      dailyByDate.set(date, (dailyByDate.get(date) ?? 0) + requests);
      totalRequests += requests;
    }
  }

  return { dailyByDate, totalRequests };
}

async function fetchOpenAiUserCosts(startingAtUnix, endingAtUnix) {
  if (!OPENAI_ENABLED) return new Map();
  const buckets = await fetchOpenAiCostBuckets(startingAtUnix, endingAtUnix, [
    "user_id",
  ]);
  const byEmail = new Map();
  for (const bucket of buckets) {
    for (const row of bucket.results) {
      const email = row.user_email;
      if (!email) continue;
      byEmail.set(email, (byEmail.get(email) ?? 0) + (row.amount?.value ?? 0));
    }
  }
  return byEmail;
}

async function fetchOpenAiProjectCosts(startingAtUnix, endingAtUnix) {
  if (!OPENAI_ENABLED) return [];
  const buckets = await fetchOpenAiCostBuckets(startingAtUnix, endingAtUnix, [
    "project_id",
  ]);
  const byProject = new Map();
  for (const bucket of buckets) {
    for (const row of bucket.results) {
      const id = row.project_id ?? "unspecified";
      const name =
        row.project_name ?? (id === "unspecified" ? "Unassigned" : id);
      const t = byProject.get(id) ?? { name, spend: 0 };
      t.spend += row.amount?.value ?? 0;
      byProject.set(id, t);
    }
  }
  return [...byProject.values()].sort((a, b) => b.spend - a.spend);
}

// Same "not bucketed by day, so chunk-and-sum rather than concatenate" situation as
// fetchUserCosts above.
async function fetchUserUsageTotalsChunk(startingAt, endingAt) {
  if (MOCK_MODE) return mockUserUsageRows(startingAt, endingAt);
  const url = new URL(`${API_BASE}/user_usage_report`);
  url.searchParams.set("starting_at", startingAt);
  url.searchParams.set("ending_at", endingAt);
  url.searchParams.set("limit", "1000");

  const rows = [];
  let page;
  do {
    if (page) url.searchParams.set("page", page);
    const data = await cachedFetchJsonRanged(url);
    rows.push(...data.data);
    page = data.has_more ? data.next_page : null;
  } while (page);

  const byEmail = new Map();
  for (const row of rows) {
    const email = row.actor?.email;
    if (!email) continue;
    byEmail.set(email, {
      cacheReadInputTokens: row.cache_read_input_tokens ?? 0,
      totalTokens: row.total_tokens ?? 0,
    });
  }
  return byEmail;
}

async function fetchUserUsageTotals(startingAt, endingAt, limit) {
  if (!ANTHROPIC_ENABLED) return new Map();
  const chunkMaps = await Promise.all(
    chunkDateRange(startingAt, endingAt).map(([s, e]) =>
      fetchUserUsageTotalsChunk(s, e),
    ),
  );

  const byEmail = new Map();
  for (const chunkMap of chunkMaps) {
    for (const [email, v] of chunkMap) {
      const acc = byEmail.get(email);
      if (acc) {
        acc.cacheReadInputTokens += v.cacheReadInputTokens;
        acc.totalTokens += v.totalTokens;
      } else {
        byEmail.set(email, { ...v });
      }
    }
  }
  return byEmail;
}

async function fetchUsageBuckets(startingAt, endingAt) {
  if (!ANTHROPIC_ENABLED) return [];
  return fetchAllBuckets("usage_report", startingAt, endingAt);
}

function reduceUsageRows(rows) {
  let uncachedInputTokens = 0;
  let cacheReadInputTokens = 0;
  let cacheCreationTokens = 0;
  let outputTokens = 0;
  let requests = 0;

  for (const row of rows) {
    uncachedInputTokens += row.uncached_input_tokens ?? 0;
    cacheReadInputTokens += row.cache_read_input_tokens ?? 0;
    cacheCreationTokens +=
      (row.cache_creation?.ephemeral_5m_input_tokens ?? 0) +
      (row.cache_creation?.ephemeral_1h_input_tokens ?? 0);
    outputTokens += row.output_tokens ?? 0;
    requests += row.requests ?? 0;
  }

  // Cache-hit rate = share of processed *input* tokens served from cache
  // rather than read fresh. Cache-creation tokens are first-time writes
  // (a miss, priced at a premium), so they count as input but not as a hit.
  const totalInputTokens =
    uncachedInputTokens + cacheReadInputTokens + cacheCreationTokens;
  const cacheHitRate =
    totalInputTokens > 0 ? cacheReadInputTokens / totalInputTokens : null;

  return {
    uncachedInputTokens,
    cacheReadInputTokens,
    cacheCreationTokens,
    outputTokens,
    totalInputTokens,
    requests,
    cacheHitRate,
  };
}

function aggregateUsage(buckets) {
  return reduceUsageRows(buckets.flatMap((b) => b.results));
}

// Same shape as aggregateUsage, but split per distinct value of a group_by[]
// dimension (e.g. "model", "rbac_group_id") instead of one org-wide total.
async function fetchUsageGroupedBy(startingAt, endingAt, dimensionKey) {
  if (!ANTHROPIC_ENABLED) return [];
  return fetchAllBuckets("usage_report", startingAt, endingAt, [dimensionKey]);
}

function aggregateUsageGrouped(buckets, dimensionKey) {
  const rowsByKey = new Map();
  for (const bucket of buckets) {
    for (const row of bucket.results) {
      const key = row[dimensionKey] ?? "unspecified";
      if (!rowsByKey.has(key)) rowsByKey.set(key, []);
      rowsByKey.get(key).push(row);
    }
  }
  return new Map(
    [...rowsByKey].map(([key, rows]) => [key, reduceUsageRows(rows)]),
  );
}

// Sums cost_report amounts per distinct value of a single group_by[] dimension
// over the whole period (no daily breakdown) — used for dimensions that are
// mostly single-valued for a given org (token_type, inference_geo, speed).
// Also reports dayCount (buckets actually returned) so callers doing a previous-period
// comparison can tell a real empty period apart from one truncated by cachedFetchJsonRanged's
// history-floor clamp — see handleSegments.
async function fetchCostTotalsByDimension(startingAt, endingAt, dimensionKey) {
  if (!ANTHROPIC_ENABLED) return { totals: new Map(), dayCount: 0 };
  const buckets = await fetchAllBuckets("cost_report", startingAt, endingAt, [
    dimensionKey,
  ]);

  const totals = new Map();
  for (const bucket of buckets) {
    for (const row of bucket.results) {
      const key = row[dimensionKey] ?? "unspecified";
      const t = totals.get(key) ?? { amount: 0, listAmount: 0 };
      t.amount += toDollars(row.amount);
      t.listAmount += toDollars(row.list_amount);
      totals.set(key, t);
    }
  }
  return { totals, dayCount: buckets.length };
}

// Same per-day-per-key tracking as aggregateCostBuckets's product/model
// handling, generalized to any single cost_report group_by dimension — used
// by the Team investigation tab's combined spend+requests chart, which
// (unlike the Team table) needs a daily series, not just a period total.
function aggregateCostSeriesByDimension(buckets, dimensionKey) {
  const labels = buckets.map((b) => b.starting_at.slice(0, 10));
  const totals = new Map();
  const dailySpend = new Map();
  const dailyRequests = new Map();

  buckets.forEach((bucket, i) => {
    for (const row of bucket.results) {
      const key = row[dimensionKey] ?? "unspecified";
      const amount = toDollars(row.amount);
      const listAmount = toDollars(row.list_amount);
      const requests = row.requests ?? 0;

      const t = totals.get(key) ?? { spend: 0, listAmount: 0, requests: 0 };
      t.spend += amount;
      t.listAmount += listAmount;
      t.requests += requests;
      totals.set(key, t);

      if (!dailySpend.has(key)) {
        dailySpend.set(key, new Array(buckets.length).fill(0));
        dailyRequests.set(key, new Array(buckets.length).fill(0));
      }
      dailySpend.get(key)[i] += amount;
      dailyRequests.get(key)[i] += requests;
    }
  });

  const series = [...totals.entries()]
    .sort((a, b) => b[1].spend - a[1].spend)
    .map(([key, t]) => ({
      key,
      spend: dailySpend.get(key),
      requests: dailyRequests.get(key),
      totalSpend: t.spend,
      totalListAmount: t.listAmount,
      totalRequests: t.requests,
    }));

  return { labels, series };
}

async function fetchCostByTokenType(startingAt, endingAt) {
  const { totals } = await fetchCostTotalsByDimension(
    startingAt,
    endingAt,
    "token_type",
  );
  const amounts = new Map();
  for (const [key, t] of totals) {
    if (key === "unspecified") continue; // non-token costs (web_search, code_execution)
    amounts.set(key, t.amount);
  }
  return amounts;
}

// Estimate $ saved from caching: compare what was actually billed for input
// tokens against what the same token volume would cost with no caching at
// all (i.e. every input token billed at the plain "uncached" rate). This is
// a BLENDED estimate — one average per-token rate across whatever's in
// `usage`/`tokenCosts` (all models when called org-wide, one model's own
// rate when called per-model). If a group mixes heavily-cached traffic on
// one model with heavily-fresh traffic on a very differently priced model,
// the org-wide call will be an approximation rather than an exact figure —
// which is exactly why the per-model breakdown exists.
export function computeCachingSavings(usage, tokenCosts) {
  const uncachedAmount = tokenCosts.get("uncached_input_tokens") ?? 0;
  const cacheReadAmount = tokenCosts.get("cache_read_input_tokens") ?? 0;
  const cacheCreation5mAmount =
    tokenCosts.get("cache_creation.ephemeral_5m_input_tokens") ?? 0;
  const cacheCreation1hAmount =
    tokenCosts.get("cache_creation.ephemeral_1h_input_tokens") ?? 0;
  const actualInputCost =
    uncachedAmount +
    cacheReadAmount +
    cacheCreation5mAmount +
    cacheCreation1hAmount;

  const uncachedRatePerToken =
    usage.uncachedInputTokens > 0
      ? uncachedAmount / usage.uncachedInputTokens
      : null;
  const hypotheticalInputCost =
    uncachedRatePerToken != null
      ? usage.totalInputTokens * uncachedRatePerToken
      : null;
  const cachingSavings =
    hypotheticalInputCost != null
      ? hypotheticalInputCost - actualInputCost
      : null;

  return { actualInputCost, hypotheticalInputCost, cachingSavings };
}

async function handleEfficiency(res, searchParams) {
  const { days, startingAt, endingAt, prevStartingAt, prevEndingAt } =
    resolveRange(searchParams);

  const [buckets, tokenTypeCosts, prevBuckets, prevTokenTypeCosts] =
    await Promise.all([
      fetchUsageBuckets(startingAt, endingAt),
      fetchCostByTokenType(startingAt, endingAt),
      fetchUsageBuckets(prevStartingAt, prevEndingAt),
      fetchCostByTokenType(prevStartingAt, prevEndingAt),
    ]);
  const usage = aggregateUsage(buckets);

  // See handleCostSummary for why a partial previous period (truncated by the API's
  // history floor) is treated as "no comparison" rather than a misleading one.
  const hasFullPreviousPeriod = prevBuckets.length >= days;
  const previousUsage = hasFullPreviousPeriod
    ? aggregateUsage(prevBuckets)
    : null;
  const previous = previousUsage
    ? {
        cacheHitRate: previousUsage.cacheHitRate,
        ...computeCachingSavings(previousUsage, prevTokenTypeCosts),
      }
    : null;

  sendJson(res, 200, {
    ...usage,
    ...computeCachingSavings(usage, tokenTypeCosts),
    previous,
  });
}

// Same pagination shape as fetchCostByTokenType, but keeps model+token_type
// combinations separate instead of collapsing to one org-wide total.
async function fetchCostByModelTokenType(startingAt, endingAt) {
  if (!ANTHROPIC_ENABLED) return new Map();
  const buckets = await fetchAllBuckets("cost_report", startingAt, endingAt, [
    "model",
    "token_type",
  ]);

  const byModel = new Map();
  for (const bucket of buckets) {
    for (const row of bucket.results) {
      if (!row.token_type) continue; // non-token costs (web_search, code_execution)
      const model = row.model ?? "unspecified";
      if (!byModel.has(model)) byModel.set(model, new Map());
      const tokenCosts = byModel.get(model);
      tokenCosts.set(
        row.token_type,
        (tokenCosts.get(row.token_type) ?? 0) + toDollars(row.amount),
      );
    }
  }

  return byModel;
}

async function handleEfficiencyByModel(res, searchParams) {
  const { startingAt, endingAt } = resolveRange(searchParams);

  const [usageBuckets, costByModel] = await Promise.all([
    fetchUsageGroupedBy(startingAt, endingAt, "model"),
    fetchCostByModelTokenType(startingAt, endingAt),
  ]);
  const usageByModel = aggregateUsageGrouped(usageBuckets, "model");

  const models = [...usageByModel.entries()]
    .filter(([model]) => model !== "unspecified")
    .map(([model, usage]) => ({
      model,
      cacheHitRate: usage.cacheHitRate,
      totalInputTokens: usage.totalInputTokens,
      requests: usage.requests,
      ...computeCachingSavings(usage, costByModel.get(model) ?? new Map()),
    }))
    .sort(
      (a, b) =>
        (b.cachingSavings ?? -Infinity) - (a.cachingSavings ?? -Infinity),
    );

  sendJson(res, 200, { models });
}

async function fetchActivitySummaries(startingDate) {
  if (!ANTHROPIC_ENABLED) return [];
  if (MOCK_MODE) return mockActivitySummaries(startingDate);
  const url = new URL(`${API_BASE}/summaries`);
  url.searchParams.set("starting_date", startingDate);
  const data = await cachedFetchJson(url);
  return data.summaries ?? [];
}

function shapeActivitySummary(s) {
  return {
    date: s.starting_at?.slice(0, 10) ?? null,
    assignedSeats: s.assigned_seat_count ?? null,
    pendingInvites: s.pending_invite_count ?? null,
    dau: s.daily_active_user_count ?? null,
    wau: s.weekly_active_user_count ?? null,
    mau: s.monthly_active_user_count ?? null,
    dailyAdoptionRate: s.daily_adoption_rate ?? null,
    weeklyAdoptionRate: s.weekly_adoption_rate ?? null,
    monthlyAdoptionRate: s.monthly_adoption_rate ?? null,
  };
}

async function handleSeats(res, searchParams) {
  // /summaries reports a rolling 30-day snapshot per day rather than a clean bucketed total,
  // so there's no clean "previous period" sum the way cost_report has. The closest analog:
  // fetch every daily snapshot across the selected window and compare the value as of period
  // start against the latest one. For a custom range, this uses the "from" date but always
  // compares up through "now" (not "to") — a custom range's own end date isn't threaded
  // through here, since /summaries mainly matters as a live, current-moment metric.
  const requestedStartingDate = resolveRange(searchParams).startingAt.slice(
    0,
    10,
  );
  // A week-old starting_date is always past the ~1-day reporting lag, so this never 400s —
  // used as a fallback if the period-start date predates the org's available history
  // (see cachedFetchJsonRanged; /summaries hits the same floor but with a different error
  // shape, so it's handled here via try/catch rather than the shared clamp helper).
  const fallbackStartingDate = daysAgoISO(7).slice(0, 10);

  let summaries;
  let hasFullPreviousPeriod = true;
  try {
    summaries = await fetchActivitySummaries(requestedStartingDate);
  } catch {
    hasFullPreviousPeriod = false;
    summaries = await fetchActivitySummaries(fallbackStartingDate);
  }
  if (!summaries.length) return sendJson(res, 200, { available: false });

  const latest = summaries[summaries.length - 1];
  const earliest = summaries[0];

  sendJson(res, 200, {
    available: true,
    ...shapeActivitySummary(latest),
    previous:
      hasFullPreviousPeriod && summaries.length > 1
        ? shapeActivitySummary(earliest)
        : null,
    // Full daily series for the Adoption line on the provider overview chart —
    // the existing earliest/latest fields above are untouched for the Seat
    // utilization KPI tile, which only needs the two endpoints.
    series: summaries.map(shapeActivitySummary),
  });
}

const TOOL_ACTION_KEYS = [
  "edit_tool",
  "multi_edit_tool",
  "write_tool",
  "notebook_edit_tool",
];

// The /users endpoint is date-only (not RFC 3339) and paginates via next_page
// alone (no has_more flag). ending_date is omitted so the API defaults it to
// "most recent available day + 1", avoiding the ~1-day reporting lag 400s
// we'd otherwise hit by computing "today" ourselves.
async function fetchToolActionTotals(startingAt) {
  const url = new URL(`${API_BASE}/users`);
  url.searchParams.set("starting_date", startingAt.slice(0, 10));
  url.searchParams.set("limit", "1000");

  const totals = new Map(
    TOOL_ACTION_KEYS.map((key) => [key, { accepted: 0, rejected: 0 }]),
  );
  if (!ANTHROPIC_ENABLED) return totals;
  if (MOCK_MODE) return mockToolActionTotals(startingAt);
  let page;
  do {
    if (page) url.searchParams.set("page", page);
    const data = await cachedFetchJsonDated(url);
    for (const row of data.data) {
      const actions = row.claude_code_metrics?.tool_actions;
      if (!actions) continue;
      for (const key of TOOL_ACTION_KEYS) {
        const a = actions[key];
        if (!a) continue;
        const t = totals.get(key);
        t.accepted += a.accepted_count ?? 0;
        t.rejected += a.rejected_count ?? 0;
      }
    }
    page = data.next_page || null;
  } while (page);

  return totals;
}

async function handleToolAcceptance(res, searchParams) {
  const { startingAt } = resolveRange(searchParams);

  const totals = await fetchToolActionTotals(startingAt);
  const tools = [...totals.entries()].map(([key, t]) => ({
    key,
    accepted: t.accepted,
    rejected: t.rejected,
  }));
  const totalAccepted = tools.reduce((sum, t) => sum + t.accepted, 0);
  const totalRejected = tools.reduce((sum, t) => sum + t.rejected, 0);
  sendJson(res, 200, { tools, totalAccepted, totalRejected });
}

// Same date-only / next_page-only pagination shape as /users (see above).
// Note: attributed_list_price / estimated_overage_spend are cents-as-decimal-
// strings, same as cost_report's amount/list_amount — confirmed live (docx:
// attributed_list_price "19925.2519" / 195 invocations ≈ $1.02, matching the
// native dashboard's "docx $1.02 cost per use"). Must go through toDollars().
async function fetchSkills(startingAt, limit, endingAt = null) {
  if (!ANTHROPIC_ENABLED) return [];
  if (MOCK_MODE) return mockSkillRows(startingAt, limit);
  const url = new URL(`${API_BASE}/skills`);
  url.searchParams.set("starting_date", startingAt.slice(0, 10));
  // Omitted for the current period so the API defaults to "most recent
  // available day" — confirmed live that /skills also accepts ending_date,
  // which is what bounds a proper previous-period window (see handleSkills).
  if (endingAt) url.searchParams.set("ending_date", endingAt.slice(0, 10));
  url.searchParams.set("limit", String(Math.min(limit, 1000)));
  url.searchParams.set("order_by", "invocation_count");
  url.searchParams.set("order", "desc");

  const rows = [];
  let page;
  do {
    if (page) url.searchParams.set("page", page);
    const data = await cachedFetchJsonDated(url);
    rows.push(...data.data);
    page = rows.length < limit ? data.next_page || null : null;
  } while (page);

  return rows.slice(0, limit).map((row) => ({
    name: row.skill_name,
    users: row.distinct_user_count ?? 0,
    invocations: row.invocation_count ?? 0,
    listValue: toDollars(row.attributed_list_price ?? "0"),
    overageSpend: toDollars(row.estimated_overage_spend ?? "0"),
  }));
}

async function handleSkills(res, searchParams) {
  const { startingAt, prevStartingAt, prevEndingAt } =
    resolveRange(searchParams);
  const [skills, previousSkills] = await Promise.all([
    fetchSkills(startingAt, 50),
    // Confirmed live: adjacent /skills windows sharing a boundary date
    // partition cleanly (no double-count) — prevEndingAt equals the current
    // period's own starting_date, so this is an exact "immediately before" window.
    fetchSkills(prevStartingAt, 1000, prevEndingAt),
  ]);
  const previousByName = new Map(previousSkills.map((s) => [s.name, s]));
  for (const s of skills) {
    const prev = previousByName.get(s.name);
    s.previousListValue = prev ? prev.listValue : null;
    s.previousOverageSpend = prev ? prev.overageSpend : null;
    s.previousInvocations = prev ? prev.invocations : null;
  }
  sendJson(res, 200, { skills });
}

// /users grouping by rbac_group_id is the only way to resolve a group's
// display name — cost_report/usage_report only ever return the opaque ID.
async function fetchRbacGroupNames(startingAt) {
  if (!ANTHROPIC_ENABLED) return new Map();
  if (MOCK_MODE) return mockRbacGroupNames();
  const url = new URL(`${API_BASE}/users`);
  url.searchParams.set("starting_date", startingAt.slice(0, 10));
  url.searchParams.append("group_by[]", "rbac_group_id");
  url.searchParams.set("limit", "1000");

  const names = new Map();
  let page;
  do {
    if (page) url.searchParams.set("page", page);
    const data = await cachedFetchJsonDated(url);
    for (const row of data.data) {
      if (row.rbac_group_id)
        names.set(row.rbac_group_id, row.rbac_group_name ?? row.rbac_group_id);
    }
    page = data.next_page || null;
  } while (page);

  return names;
}

async function handleTeams(res, searchParams) {
  const { days, startingAt, endingAt, prevStartingAt, prevEndingAt } =
    resolveRange(searchParams);

  // Fetched once and reused for both the flat team table (below) and the
  // Investigation tab's top-4 daily spend+requests chart — a second
  // fetchCostTotalsByDimension call here would just re-fetch the exact same
  // cost_report buckets under Anthropic's 60/min rate limit for no reason.
  const [costBuckets, previousCostBuckets, usageBuckets, names] =
    await Promise.all([
      ANTHROPIC_ENABLED
        ? fetchAllBuckets("cost_report", startingAt, endingAt, [
            "rbac_group_id",
          ])
        : [],
      ANTHROPIC_ENABLED
        ? fetchAllBuckets("cost_report", prevStartingAt, prevEndingAt, [
            "rbac_group_id",
          ])
        : [],
      fetchUsageGroupedBy(startingAt, endingAt, "rbac_group_id"),
      fetchRbacGroupNames(startingAt),
    ]);
  const { labels, series } = aggregateCostSeriesByDimension(
    costBuckets,
    "rbac_group_id",
  );
  const previous = aggregateCostSeriesByDimension(
    previousCostBuckets,
    "rbac_group_id",
  );
  const usageByGroup = aggregateUsageGrouped(usageBuckets, "rbac_group_id");

  // Same truncated-previous-period guard as handleCostSummary — a wide range's
  // "previous period" can come back short if it predates the org's history floor.
  const hasFullPreviousPeriod = previous.labels.length >= days;
  const previousByKey = new Map(previous.series.map((t) => [t.key, t]));

  const nameFor = (id) =>
    id === "unspecified" ? "Ungrouped" : (names.get(id) ?? id);

  const teams = series
    .map((t) => {
      const usage = usageByGroup.get(t.key);
      const savings = t.totalListAmount - t.totalSpend;
      const prev = hasFullPreviousPeriod ? previousByKey.get(t.key) : null;
      return {
        id: t.key,
        name: nameFor(t.key),
        spend: t.totalSpend,
        listAmount: t.totalListAmount,
        savings,
        savingsPct:
          t.totalListAmount > 0 ? (savings / t.totalListAmount) * 100 : null,
        cacheHitRate: usage?.cacheHitRate ?? null,
        requests: t.totalRequests,
        previousSpend: prev ? prev.totalSpend : null,
        previousRequests: prev ? prev.totalRequests : null,
      };
    })
    .sort((a, b) => b.spend - a.spend);

  const teamSeries = {
    labels,
    series: series.slice(0, 4).map((t) => ({
      name: nameFor(t.key),
      spend: t.spend,
      requests: t.requests,
    })),
  };

  sendJson(res, 200, { teams, teamSeries });
}

async function handleSegments(res, searchParams) {
  const { days, startingAt, endingAt, prevStartingAt, prevEndingAt } =
    resolveRange(searchParams);

  const [geo, speed, prevGeo, prevSpeed] = await Promise.all([
    fetchCostTotalsByDimension(startingAt, endingAt, "inference_geo"),
    fetchCostTotalsByDimension(startingAt, endingAt, "speed"),
    fetchCostTotalsByDimension(prevStartingAt, prevEndingAt, "inference_geo"),
    fetchCostTotalsByDimension(prevStartingAt, prevEndingAt, "speed"),
  ]);

  const toTotals = (totals) => {
    const out = { total: 0 };
    for (const [key, t] of totals) {
      out[key] = t.amount;
      out.total += t.amount;
    }
    return out;
  };

  // See handleCostSummary for why a partial previous period (truncated by the API's
  // history floor) is treated as "no comparison" rather than a misleading one.
  const hasFullPreviousPeriod = prevGeo.dayCount >= days;

  sendJson(res, 200, {
    geo: toTotals(geo.totals),
    speed: toTotals(speed.totals),
    previous: hasFullPreviousPeriod
      ? { geo: toTotals(prevGeo.totals), speed: toTotals(prevSpeed.totals) }
      : null,
  });
}

function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

const ALLOWED_RANGE_DAYS = [7, 28, 90, 180, 365];

export function rangeDays(searchParams) {
  const days = Number.parseInt(searchParams.get("days"), 10);
  return ALLOWED_RANGE_DAYS.includes(days) ? days : 7;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const isValidDateParam = (s) =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

// Resolves either a preset `?days=N` or an explicit `?from=YYYY-MM-DD&to=YYYY-MM-DD` custom
// range into one shape every handler can use: the current window plus an equal-length
// "previous period" immediately before it, in both RFC3339 (Anthropic) and unix-seconds
// (OpenAI) form. `to` is inclusive — a day is added internally so the whole `to` date's data
// is included, not just up to its midnight boundary.
export function resolveRange(searchParams) {
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  let startingAtMs = null;
  let endingAtMs = null;
  if (isValidDateParam(from) && isValidDateParam(to)) {
    const fromMs = Date.parse(`${from}T00:00:00.000Z`);
    const toMs = Date.parse(`${to}T00:00:00.000Z`) + DAY_MS;
    if (toMs > fromMs) {
      startingAtMs = fromMs;
      endingAtMs = Math.min(toMs, Date.now());
    }
  }
  if (startingAtMs == null) {
    const presetDays = rangeDays(searchParams);
    endingAtMs = Date.now();
    startingAtMs = endingAtMs - presetDays * DAY_MS;
  }

  const days = Math.max(1, Math.round((endingAtMs - startingAtMs) / DAY_MS));
  const prevEndingAtMs = startingAtMs;
  const prevStartingAtMs = startingAtMs - days * DAY_MS;

  const iso = (ms) => new Date(ms).toISOString();
  const unix = (ms) => Math.floor(ms / 1000);

  return {
    days,
    startingAt: iso(startingAtMs),
    endingAt: iso(endingAtMs),
    startingAtUnix: unix(startingAtMs),
    endingAtUnix: unix(endingAtMs),
    prevStartingAt: iso(prevStartingAtMs),
    prevEndingAt: iso(prevEndingAtMs),
    prevStartingAtUnix: unix(prevStartingAtMs),
    prevEndingAtUnix: unix(prevEndingAtMs),
  };
}

async function handleCostSummary(res, searchParams) {
  const {
    days,
    startingAt,
    endingAt,
    startingAtUnix,
    endingAtUnix,
    prevStartingAt,
    prevEndingAt,
    prevStartingAtUnix,
    prevEndingAtUnix,
  } = resolveRange(searchParams);

  const [
    currentBuckets,
    previousBuckets,
    contextWindowBuckets,
    openaiBuckets,
    previousOpenaiBuckets,
    openaiUsageBuckets,
    previousOpenaiUsageBuckets,
  ] = await Promise.all([
    fetchCostBuckets(startingAt, endingAt),
    fetchCostBuckets(prevStartingAt, prevEndingAt),
    fetchCostByContextWindow(startingAt, endingAt),
    fetchOpenAiCostBuckets(startingAtUnix, endingAtUnix, []),
    fetchOpenAiCostBuckets(prevStartingAtUnix, prevEndingAtUnix, []),
    fetchOpenAiUsageBuckets(startingAtUnix, endingAtUnix),
    fetchOpenAiUsageBuckets(prevStartingAtUnix, prevEndingAtUnix),
  ]);

  const current = aggregateCostBuckets(currentBuckets);
  const previous = aggregateCostBuckets(previousBuckets);
  const byContextWindow = aggregateContextWindow(contextWindowBuckets);
  const openai = aggregateOpenAiCostBuckets(openaiBuckets);
  const previousOpenai = aggregateOpenAiCostBuckets(previousOpenaiBuckets);
  const openaiUsage = aggregateOpenAiUsageBuckets(openaiUsageBuckets);
  const previousOpenaiUsage = aggregateOpenAiUsageBuckets(
    previousOpenaiUsageBuckets,
  );

  // The Analytics API only has data back to a fixed org-wide start date (see
  // cachedFetchJsonRanged), so a same-length "previous period" comparison can come back
  // truncated for wide ranges — a 365d range's "previous 365d" hasn't fully happened yet for
  // this org. A partial period would make the % change meaningless (fewer days summed against
  // more days always looks like a drop), so only expose a comparison when the previous window
  // came back full.
  const hasFullPreviousPeriod = previous.labels.length >= days;

  // Attaches each row's previous-period total (by name) for the Investigation
  // tab's per-row trend — aggregateCostBuckets already computes a full
  // byProduct/byModel breakdown for whatever buckets it's given, so this is
  // just exposing data it was already computing for the previous period and
  // discarding.
  const withPrevious = (currentSeries, previousSeries) => {
    const prevByName = new Map(previousSeries.map((s) => [s.name, s]));
    return currentSeries.map((s) => {
      const prev = hasFullPreviousPeriod ? prevByName.get(s.name) : null;
      return {
        ...s,
        previousSpend: prev ? prev.totalSpend : null,
        previousRequests: prev ? prev.requests : null,
      };
    });
  };

  const anthropicSpend = current.totals.spend;
  const openaiSpend = openai.totalSpend;
  const byProvider = [
    {
      name: "Anthropic",
      spend: current.daily.map((d) => d.spend),
      requests: current.daily.map((d) => d.requests),
      totalSpend: anthropicSpend,
      totalRequests: current.totals.requests,
    },
    {
      name: "OpenAI",
      spend: current.labels.map((d) => openai.dailyByDate.get(d) ?? 0),
      requests: current.labels.map((d) => openaiUsage.dailyByDate.get(d) ?? 0),
      totalSpend: openaiSpend,
      totalRequests: openaiUsage.totalRequests,
    },
  ];

  sendJson(res, 200, {
    labels: current.labels,
    overall: current.daily,
    byProduct: withPrevious(current.byProduct, previous.byProduct),
    byModel: withPrevious(current.byModel, previous.byModel),
    byContextWindow,
    byProvider,
    totals: {
      ...current.totals,
      spend: anthropicSpend + openaiSpend,
      anthropicSpend,
      openaiSpend,
      requests: current.totals.requests + openaiUsage.totalRequests,
      savings: current.totals.listAmount - current.totals.spend,
      previous: hasFullPreviousPeriod
        ? {
            spend: previous.totals.spend + previousOpenai.totalSpend,
            anthropicSpend: previous.totals.spend,
            openaiSpend: previousOpenai.totalSpend,
            requests:
              previous.totals.requests + previousOpenaiUsage.totalRequests,
            savings: previous.totals.listAmount - previous.totals.spend,
          }
        : null,
    },
  });
}

async function handlePeople(res, searchParams) {
  const limit = Math.min(
    Number.parseInt(searchParams.get("limit") ?? "1000", 10) || 1000,
    1000,
  );
  const {
    startingAt,
    endingAt,
    startingAtUnix,
    endingAtUnix,
    prevStartingAt,
    prevEndingAt,
    prevStartingAtUnix,
    prevEndingAtUnix,
  } = resolveRange(searchParams);

  const [
    people,
    usageByEmail,
    openaiByEmail,
    previousPeople,
    previousOpenaiByEmail,
  ] = await Promise.all([
    fetchUserCosts(startingAt, endingAt, limit),
    fetchUserUsageTotals(startingAt, endingAt, limit),
    fetchOpenAiUserCosts(startingAtUnix, endingAtUnix),
    fetchUserCosts(prevStartingAt, prevEndingAt, limit),
    fetchOpenAiUserCosts(prevStartingAtUnix, prevEndingAtUnix),
  ]);

  // user_cost_report/OpenAI costs are period totals, not day-bucketed, so
  // there's no cachedFetchJsonRanged dayCount to check for truncation the
  // way handleCostSummary does — this trend is a best-effort comparison,
  // not gated on a "full previous period" check like the bucketed endpoints.
  const previousAmountByEmail = new Map();
  for (const p of previousPeople) {
    if (!p.email) continue;
    previousAmountByEmail.set(
      p.email,
      p.amount + (previousOpenaiByEmail.get(p.email) ?? 0),
    );
  }
  for (const [email, amount] of previousOpenaiByEmail) {
    if (!previousAmountByEmail.has(email))
      previousAmountByEmail.set(email, amount);
  }

  const byEmail = new Map();
  for (const person of people) {
    const usage = person.email ? usageByEmail.get(person.email) : null;
    person.cacheHitRate =
      usage && usage.totalTokens > 0
        ? usage.cacheReadInputTokens / usage.totalTokens
        : null;
    person.anthropicAmount = person.amount;
    person.openaiAmount = person.email
      ? (openaiByEmail.get(person.email) ?? 0)
      : 0;
    person.amount = person.anthropicAmount + person.openaiAmount;
    person.previousAmount = person.email
      ? (previousAmountByEmail.get(person.email) ?? null)
      : null;
    if (person.email) byEmail.set(person.email, person);
  }
  // Add people who only show up in OpenAI's cost data (no Anthropic Analytics record).
  for (const [email, openaiAmount] of openaiByEmail) {
    if (byEmail.has(email)) continue;
    people.push({
      name: email,
      email,
      amount: openaiAmount,
      listAmount: 0,
      requests: 0,
      cacheHitRate: null,
      anthropicAmount: 0,
      openaiAmount,
      previousAmount: previousAmountByEmail.get(email) ?? null,
    });
  }
  people.sort((a, b) => b.amount - a.amount);

  sendJson(res, 200, { people });
}

async function handleOpenAiProjects(res, searchParams) {
  const { startingAtUnix, endingAtUnix } = resolveRange(searchParams);
  const projects = await fetchOpenAiProjectCosts(startingAtUnix, endingAtUnix);
  sendJson(res, 200, { projects });
}

// The packaged build has no source tree to read index.html from — it's embedded as a SEA
// asset at build time instead (see sea-config.json) and fetched via node:sea's getAsset.
async function loadIndexHtml() {
  const html = isSea()
    ? getAsset("index.html", "utf8")
    : await readFile(join(ROOT, "index.html"), "utf8");
  const inject = [];
  // Only ever true for the demo build (see build-mac-demo.sh) — real builds serve this file
  // byte-for-byte unchanged. index.html reads this flag to show a persistent "Demo — sample
  // data" badge so mock data is never mistaken for a real connected account.
  if (MOCK_MODE) inject.push("window.__ATS_MOCK_MODE__=true;");
  // The header's per-provider status chips need to know what's actually connected — never
  // the real key, only whether one exists and its masked form (see maskKey above).
  const providers = JSON.stringify({
    anthropic: {
      connected: ANTHROPIC_ENABLED,
      masked: ANTHROPIC_ENABLED ? maskKey(KEY) : null,
    },
    openai: {
      connected: OPENAI_ENABLED,
      masked: OPENAI_ENABLED ? maskKey(OPENAI_KEY) : null,
    },
  }).replace(/</g, "\\u003c");
  inject.push(`window.__ATS_PROVIDERS__=${providers};`);
  const withInject = html
    .replace("</head>", `<script>${inject.join("")}</script></head>`)
    // index.html has no <link rel="icon"> of its own — sourced from the same moss-logo-v2.svg
    // file as everything else now (see FAVICON_SVG above) rather than a separately maintained
    // copy, so the tab icon and the header logo can never quietly drift apart.
    .replace("</head>", `${FAVICON_LINK_TAG}</head>`);
  // Same wordmark asset (icon + "moss" letters, one vector graphic) the white nav-bar
  // (setupPageHtml/onboardingGuideHtml, MOSS_WORDMARK_SVG below) renders — unifies the two
  // headers' logo to identical proportions instead of this one being a separately-sized
  // icon-in-a-badge plus real HTML text. Left at the source file's own currentColor fill
  // (unlike MOSS_WORDMARK_SVG, which hardcodes near-black for the white nav-bar) so it
  // inherits .app-bar's white text color; sized via CSS (.brand-mark svg), not baked-in
  // width/height attributes — see the <!--ICON:moss-wordmark--> placeholder above.
  return withInject.replace("<!--ICON:moss-wordmark-->", MOSS_LOGO_SOURCE_SVG);
}

async function serveStatic(req, res, pathname) {
  if (pathname === "/" || pathname === "/index.html") {
    const content = await loadIndexHtml();
    // This page's content varies per request now (window.__ATS_PROVIDERS__ reflects
    // whatever's currently connected) — without this, a bare reload after adding/changing/
    // removing a key could show a browser-cached copy with the old provider state baked in.
    res.writeHead(200, {
      "Content-Type": "text/html",
      "Cache-Control": "no-store",
    });
    return res.end(content);
  }
  // The dashboard is a single self-contained index.html with no other static assets, so a
  // packaged build (which has no ROOT to serve other files from) just 404s anything else.
  if (isSea()) {
    res.writeHead(404);
    return res.end("Not found");
  }
  const filePath = join(ROOT, pathname);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  const content = await readFile(filePath);
  res.writeHead(200, {
    "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream",
  });
  res.end(content);
}

// Small standalone page (not the dashboard's own CSS/JS) shown until an Admin API key is
// on file — lets someone who downloaded the packaged app get going with no terminal, no
// text editor, and no knowledge of what a .env file is.
// Wizard copy for both providers — kept as data so the client script and the
// "how do I get this" instructions/request-templates stay in one place. Anthropic's
// request template deliberately does NOT offer a "read only" option: Anthropic has no
// scoped/read-only variant of an Admin API key (confirmed against their docs), any Admin
// key is full org admin access. OpenAI's does ask for "Read only", since that option is
// real there — don't make the two symmetrical just for tidiness.
// Copy for the two-step onboarding wizard, keyed by provider. Anthropic's copy
// deliberately does NOT offer a "read only" option: Anthropic has no scoped/read-only
// variant of an Admin API key (confirmed against their docs) — any Admin key is full org
// admin access. OpenAI's copy hedges ("if it asks you to choose permissions") rather than
// asserting a Read Only option exists for the specific admin-key type this app uses
// (platform.openai.com/settings/organization/admin-keys) — that's confirmed for OpenAI's
// separate ChatGPT "Admin Console" product, not for this one. See HANDOFF.md.
const PROVIDER_COPY = {
  anthropic: {
    title: "Add Anthropic (Claude) Analytics API key",
    shortName: "Anthropic",
    credentialName: "Analytics API key",
    badgeBg: "#d6f1e5",
    badgeFg: "#265f4f",
    intro:
      "This dashboard reads Anthropic's Claude Enterprise Analytics API to show your Claude spend, usage and adoption.",
    consoleUrl: "https://claude.ai/admin-settings/api-access",
    helpGuideUrl: "https://support.claude.com/en/articles/15330651-claude-enterprise-admin-api-reference-guide?utm_source=chatgpt.com",
    helpGuideLabel: "Claude Admin API key guide",
    keyPrefix: "sk-ant-",
    steps: [
      {
        text: "Go to your organization's API access settings in claude.ai.",
        chip: true,
      },
      { text: "Turn on public API access if it isn't already." },
      { text: "Create an Analytics API key, then copy it and paste it below." },
    ],
    fieldLabelSelf: "Anthropic Analytics API key",
    reservedNote:
      "This key only grants read:analytics access — it can read usage and cost data but can't make any changes to your account.",
    delegateIntro: "Send this to your organization's primary owner:",
    messageCardTitle: "Message for your Anthropic org owner",
    invalidFormatMsg:
      "That doesn't look like an Anthropic key — double-check what they sent, or that you copied the whole value.",
    permissionErrorMsg:
      "This Anthropic key doesn't have the right access. Ask whoever created it to generate an Analytics API key, not a regular API key.",
    requestMessage:
      "Hi, I'm setting up Moss AI Token Cost Tracker, a local finance tool provided by Moss (a German fintech company) to compare AI token costs across providers. Could you create an Analytics API key for our Anthropic organisation?\n\n" +
      "1. Go to https://claude.ai/admin-settings/api-access\n\n" +
      "2. Turn on public API access if needed.\n\n" +
      "3. Create an Analytics API key.\n\n" +
      "4. Copy the key and share it with me securely.\n\n" +
      "The key only grants read access and cannot make changes. It stays on my device and is never sent to Moss. I can also share the GitHub code for review.",
  },
  openai: {
    title: "Add OpenAI (ChatGPT) Admin API key",
    shortName: "OpenAI",
    credentialName: "Admin API key",
    badgeBg: "#f1f1f1",
    badgeFg: "#5b5858",
    intro:
      "Add this to see combined spend across both providers. You can always add it later from settings.",
    consoleUrl: "https://platform.openai.com/settings/organization/admin-keys",
    helpGuideUrl: "https://help.openai.com/en/articles/20001407?utm_source=chatgpt.com",
    helpGuideLabel: "OpenAI Admin key guide",
    keyPrefix: "sk-",
    steps: [
      { text: "Go to your OpenAI Platform admin keys page.", chip: true },
      { text: "Click <b>Create new admin key</b>." },
      {
        text: "If it asks you to choose permissions, select <b>Read only</b> - then copy the key and paste it below either way.",
      },
    ],
    fieldLabelSelf: "OpenAI Admin API key",
    reservedNote:
      "If you were able to choose Read only permissions, this key can only read spend and usage data — nothing can be changed with it.",
    delegateIntro: "Send this to whoever manages your OpenAI account:",
    messageCardTitle: "Message for your OpenAI admin",
    invalidFormatMsg:
      "That doesn't look like a valid OpenAI key — double-check what your admin sent, or that you copied the whole value.",
    permissionErrorMsg:
      "This OpenAI key doesn't have Admin permissions. Ask whoever created it to generate an Admin API key, not a standard API key.",
    requestMessage:
      "Hi, I'm setting up Moss AI Token Cost Tracker, a local finance tool provided by Moss (a German fintech company) to compare AI token costs across providers. Could you create an Admin API key for our OpenAI organisation?\n\n" +
      "1. Go to https://platform.openai.com/settings/organization/keys\n\n" +
      '2. Click "Create new admin key".\n\n' +
      '3. Select "Read only" if asked to choose permissions.\n\n' +
      "4. Copy the key and share it with me securely.\n\n" +
      "The key is only used to read spend and usage data. It stays on my device and is never sent to Moss. I can also share the GitHub code for review.",
  },
};

// Shared page-level copy for the parallel two-card layout (not per-provider, so it lives
// outside PROVIDER_COPY). Three modes: first-run setup (neither provider configured yet,
// both cards shown) vs. adding the one missing provider to an already-running dashboard
// (single card shown) — see setupPageHtml() for how ANTHROPIC_ENABLED/OPENAI_ENABLED pick
// the mode. The two "add" variants intentionally use different copy, not just a swapped
// provider name: connecting Anthropic genuinely unlocks Claude adoption tracking (see
// available-data-points.md — "Seat and adoption summaries" only exists under Anthropic),
// connecting OpenAI never does, so only one of them can honestly mention it.
export function setupPageCopy(mode) {
  if (mode === "add-openai") {
    return {
      title: "Add OpenAI (ChatGPT)",
      subtitle:
        "Add OpenAI to see combined AI cost and usage across both providers.",
      cards: ["openai"],
      buttonLabel: "Add OpenAI",
    };
  }
  if (mode === "add-anthropic") {
    return {
      title: "Add Anthropic (Claude)",
      subtitle:
        "Add Anthropic to see combined AI cost and usage across both providers, plus Claude adoption tracking.",
      cards: ["anthropic"],
      buttonLabel: "Add Anthropic",
    };
  }
  // Reached from the dashboard header's "Change key" action (see setupPageHtml's
  // ?provider= handling) — same single-card layout as "add-*" above, but the provider is
  // already connected, so the copy and button read as an update rather than a first connect.
  if (mode === "change-anthropic") {
    return {
      title: "Change your Anthropic key",
      subtitle:
        "Paste a new Admin API key to replace the one currently connected.",
      cards: ["anthropic"],
      buttonLabel: "Save key",
    };
  }
  if (mode === "change-openai") {
    return {
      title: "Change your OpenAI key",
      subtitle:
        "Paste a new Admin API key to replace the one currently connected.",
      cards: ["openai"],
      buttonLabel: "Save key",
    };
  }
  return {
    title: "Connect your AI providers via API keys",
    subtitle:
      "Connect one provider to view its spend. Connect both to combine and compare spend across providers.",
    cards: ["anthropic", "openai"],
    buttonLabel: "Open dashboard",
  };
}

const SETUP_CLIENT_SCRIPT = `
    const PROVIDERS = JSON.parse(document.getElementById('providers-data').textContent);
    const PAGE = JSON.parse(document.getElementById('page-data').textContent);

    const ICONS = {
      key: '${KEY_ICON_SVG}',
      send: '${SEND_ICON_SVG}',
      chevronRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="1em" height="1em"><path d="M9 6l6 6-6 6"/></svg>',
      chevronLeft: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="1em" height="1em"><path d="M15 6l-6 6 6 6"/></svg>',
      lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" width="1em" height="1em"><rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/></svg>',
      warning: '<svg viewBox="0 0 24 24" width="1em" height="1em"><path d="M12 3.5 22 20H2L12 3.5Z" fill="currentColor"/><rect x="11.1" y="9.3" width="1.8" height="5.2" rx="0.9" fill="#fff"/><rect x="11.1" y="15.4" width="1.8" height="1.8" rx="0.9" fill="#fff"/></svg>',
      info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="1em" height="1em"><circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16" stroke-linecap="round"/><circle cx="12" cy="7.7" r="1" fill="currentColor" stroke="none"/></svg>',
      eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" width="1em" height="1em"><path d="M1.5 12S5 5 12 5s10.5 7 10.5 7-3.5 7-10.5 7S1.5 12 1.5 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
      eyeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" width="1em" height="1em"><path d="M1.5 12S5 5 12 5s10.5 7 10.5 7-3.5 7-10.5 7S1.5 12 1.5 12Z"/><circle cx="12" cy="12" r="3"/><line x1="3" y1="3" x2="21" y2="21"/></svg>',
      check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="1em" height="1em"><path d="M4 12.5l5 5L20 6.5"/></svg>',
      copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" width="1em" height="1em"><rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 8.5V5.5a2 2 0 0 0-2-2h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>',
      externalLink: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="1em" height="1em"><path d="M9 5h10v10"/><path d="M19 5L5 19"/></svg>',
      pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" width="1em" height="1em"><path d="M15.5 4.5l4 4L7 21H3v-4Z"/></svg>',
      spinner: '<svg viewBox="0 0 24 24" fill="none" width="1em" height="1em"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-dasharray="32 200"/></svg>',
      anthropicLogo: '${ANTHROPIC_LOGO_SVG}',
      openaiLogo: '${OPENAI_LOGO_SVG}',
    };
    function icon(name, size) {
      return '<span class="icon" style="font-size:' + (size || 16) + 'px">' + ICONS[name] + '</span>';
    }
    function escapeAttr(s) {
      return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    }
    function escapeHtml(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function maskKey(key) {
      if (key.length <= 17) return '••••••••' + key.slice(-4);
      return key.slice(0, 13) + '••••••••' + key.slice(-4);
    }

    const state = {
      anthropic: { key: '', status: 'idle', error: '', reveal: false, copied: false, showDelegate: false },
      openai: { key: '', status: 'idle', error: '', reveal: false, copied: false, showDelegate: false },
      saving: false,
    };

    function cardHeader(key) {
      const p = PROVIDERS[key];
      const s = state[key];
      const logoIcon = key === 'anthropic' ? 'anthropicLogo' : 'openaiLogo';
      const left = '<div class="avatar" style="background:' + p.badgeBg + ';color:' + p.badgeFg + '">' + icon(logoIcon, 18) + '</div>';
      const connectedTag = s.status === 'valid'
        ? '<div class="connected-tag">' + icon('check', 14) + '<span>Connected</span></div>'
        : '';
      return (
        '<div class="card-head">' + left +
          '<div class="card-name">' + (key === 'anthropic' ? 'Claude' : 'ChatGPT') + '</div>' +
          connectedTag +
        '</div>'
      );
    }

    function connectedSummary(key) {
      const s = state[key];
      return (
        '<div class="connected-summary">' + icon('lock', 14) +
          '<span class="connected-key">' + escapeHtml(maskKey(s.key)) + '</span>' +
          '<button type="button" class="change-btn" data-action="change">' + icon('pencil', 12) + '<span>Change</span></button>' +
        '</div>'
      );
    }

    function fieldSteps(key) {
      const p = PROVIDERS[key];
      return '<div class="field-steps">' + p.steps.map(function (step, i) {
        return (
          '<div class="field-step-row">' +
            '<span class="field-step-num">' + String(i + 1).padStart(2, '0') + '</span>' +
            '<span>' + (step.chip
              ? '<a class="step-link" href="' + p.consoleUrl + '" target="_blank" rel="noopener noreferrer">' + step.text + '</a>'
              : step.text) +
            '</span>' +
          '</div>'
        );
      }).join('') + '</div>';
    }

    function keyField(key) {
      const s = state[key];
      const p = PROVIDERS[key];
      const errHtml = s.error
        ? icon('warning', 13) + '<span>' + s.error + '</span>'
        : '';
      return (
        '<div class="key-input-wrap">' +
          '<input type="' + (s.reveal ? 'text' : 'password') + '" id="key-input-' + key + '" autocomplete="off" placeholder="Paste key here" value="' + escapeAttr(s.key) + '" class="' + (s.status === 'invalid' ? 'input-error' : '') + '" />' +
          (s.status === 'checking' ? '<span class="key-spinner spin">' + icon('spinner', 14) + '</span>' : '') +
          '<button type="button" class="reveal-btn" data-action="reveal">' + icon(s.reveal ? 'eyeOff' : 'eye', 15) + '</button>' +
        '</div>' +
        '<div class="key-format-hint">Example format: ' + p.keyPrefix + '&hellip;</div>' +
        '<div class="field-error' + (s.error ? '' : '-slot') + '" id="field-error-' + key + '">' + errHtml + '</div>'
      );
    }

    function fieldNote(key) {
      return '<div class="field-note">' + icon('info', 12) + '<span>' + PROVIDERS[key].reservedNote + '</span></div>';
    }

    function delegateMessageBlock(key) {
      const p = PROVIDERS[key];
      const s = state[key];
      return (
        '<div class="delegate-intro">' + p.delegateIntro + '</div>' +
        '<div class="message-card">' +
          '<div class="message-card-head">' +
            icon('send', 12) +
            '<span class="message-card-title">' + p.messageCardTitle + '</span>' +
            '<button type="button" class="copy-btn' + (s.copied ? ' copy-btn-done' : '') + '" data-action="copy">' +
              icon(s.copied ? 'check' : 'copy', 12) + '<span>' + (s.copied ? 'Copied' : 'Copy') + '</span>' +
            '</button>' +
          '</div>' +
          '<div class="message-card-body">' + escapeHtml(p.requestMessage) + '</div>' +
        '</div>' +
        '<div class="reassurance">This message doesn&#39;t include your key or any account access.</div>'
      );
    }

    function selfBlock(key) {
      const p = PROVIDERS[key];
      const s = state[key];
      return (
        '<a class="help-center-link" href="' + p.helpGuideUrl + '" target="_blank" rel="noopener noreferrer"><span>' + p.helpGuideLabel + '</span>' + icon('externalLink', 12) + '</a>' +
        fieldSteps(key) +
        keyField(key) +
        fieldNote(key) +
        '<button type="button" class="delegate-toggle-btn" data-action="toggle-delegate">' + icon('send', 12) +
          '<span>' + (s.showDelegate ? 'Hide the prewritten message' : 'Need to ask someone else? Get a prewritten message') + '</span>' +
        '</button>' +
        (s.showDelegate ? delegateMessageBlock(key) : '')
      );
    }

    function cardBody(key) {
      const s = state[key];
      if (s.status === 'valid') return connectedSummary(key);
      return selfBlock(key);
    }

    function renderCard(key) {
      const s = state[key];
      const el = document.getElementById('card-' + key);
      el.className = 'provider-card' + (s.status === 'valid' ? ' connected' : '');
      el.innerHTML = cardHeader(key) + '<div class="card-body">' + cardBody(key) + '</div>';
      bindCard(key);
    }

    function renderBottom() {
      // Two shapes: first-run setup renders both cards and lets either one alone satisfy
      // canProceed; add-provider mode renders a single card, so canProceed just tracks that
      // one card's status.
      const singleKey = PAGE.cards.length === 1 ? PAGE.cards[0] : null;
      let canProceed, hint;
      if (singleKey) {
        canProceed = state[singleKey].status === 'valid';
        hint = canProceed ? "You're all set." : 'Paste your key to continue.';
      } else {
        const a = state.anthropic.status === 'valid';
        const o = state.openai.status === 'valid';
        canProceed = a || o;
        hint = '';
        if (a && o) hint = "You're all set.";
        else if (a) hint = 'Add OpenAI too for combined spend, or continue with just Anthropic.';
        else if (o) hint = 'Add Anthropic too for combined spend, or continue with just OpenAI.';
      }
      const btn = document.getElementById('proceed-btn');
      btn.disabled = !canProceed || state.saving;
      btn.textContent = state.saving ? 'Saving…' : PAGE.buttonLabel;
      document.getElementById('proceed-hint').textContent = state.saving ? '' : hint;
    }

    function bindCard(key) {
      const el = document.getElementById('card-' + key);
      const s = state[key];
      const p = PROVIDERS[key];

      const delegateToggleBtn = el.querySelector('[data-action="toggle-delegate"]');
      if (delegateToggleBtn) delegateToggleBtn.addEventListener('click', function () {
        s.showDelegate = !s.showDelegate;
        renderCard(key);
      });

      const changeBtn = el.querySelector('[data-action="change"]');
      if (changeBtn) changeBtn.addEventListener('click', function () {
        s.status = 'idle';
        s.error = '';
        renderCard(key);
        renderBottom();
      });

      const copyBtn = el.querySelector('[data-action="copy"]');
      if (copyBtn) copyBtn.addEventListener('click', function () {
        navigator.clipboard.writeText(p.requestMessage);
        s.copied = true;
        renderCard(key);
        clearTimeout(window['__atsCopyTimer_' + key]);
        window['__atsCopyTimer_' + key] = setTimeout(function () {
          s.copied = false;
          renderCard(key);
        }, 1800);
      });

      const revealBtn = el.querySelector('[data-action="reveal"]');
      if (revealBtn) revealBtn.addEventListener('click', function () {
        s.reveal = !s.reveal;
        const input = document.getElementById('key-input-' + key);
        if (input) input.type = s.reveal ? 'text' : 'password';
        revealBtn.innerHTML = icon(s.reveal ? 'eyeOff' : 'eye', 15);
      });

      const input = el.querySelector('input[type="password"], input[type="text"]');
      if (input) {
        input.addEventListener('input', function () {
          s.key = input.value.trim();
          s.status = 'idle';
          const looksRight = !s.key || s.key.indexOf(p.keyPrefix) === 0;
          const errSlot = document.getElementById('field-error-' + key);
          if (looksRight) {
            s.error = '';
            errSlot.className = 'field-error-slot';
            errSlot.innerHTML = '';
          } else {
            s.error = p.invalidFormatMsg;
            errSlot.className = 'field-error';
            errSlot.innerHTML = icon('warning', 13) + '<span>' + s.error + '</span>';
          }
          input.className = looksRight ? '' : 'input-error';

          // Debounce the live check so pasting or typing a key verifies on its own after a
          // short pause — no need to click elsewhere first. Blur still checks immediately
          // (clearing any pending debounce) for the case where focus leaves before it fires.
          clearTimeout(s.verifyDebounceTimer);
          if (s.key) {
            s.verifyDebounceTimer = setTimeout(function () { verifyProvider(key); }, 500);
          }
        });
        input.addEventListener('blur', function () {
          clearTimeout(s.verifyDebounceTimer);
          verifyProvider(key);
        });
      }
    }

    async function verifyProvider(key) {
      const s = state[key];
      const value = s.key.trim();
      if (!value || s.status === 'checking') return;
      s.status = 'checking';
      renderCard(key);
      try {
        const res = await fetch('/verify-key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: key, key: value }),
        });
        const data = await res.json();
        if (data.valid) {
          s.status = 'valid';
          s.error = '';
        } else {
          s.status = 'invalid';
          s.error = data.error || 'That key was rejected - double-check you copied the whole value.';
        }
      } catch (e) {
        s.status = 'invalid';
        s.error = 'Could not reach the app to check this key — try again.';
      }
      renderCard(key);
      renderBottom();
    }

    async function proceed() {
      state.saving = true;
      renderBottom();
      const anthropicKey = state.anthropic.status === 'valid' ? state.anthropic.key : '';
      const openaiKey = state.openai.status === 'valid' ? state.openai.key : '';
      try {
        const res = await fetch('/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ anthropicKey: anthropicKey, openaiKey: openaiKey }),
        });
        const data = await res.json();
        if (!res.ok) {
          state.saving = false;
          const field = data.field === 'openai' || data.field === 'anthropic' ? data.field : null;
          if (field) {
            state[field].status = 'invalid';
            state[field].error = data.error || 'Something went wrong — try again.';
            renderCard(field);
          } else {
            alert(data.error || 'Something went wrong — try again.');
          }
          renderBottom();
          return;
        }
        document.body.innerHTML =
          '<div class="done-wrap"><div class="done-title">' + icon('check', 22) + '<span>Saved</span></div><div class="done-sub">Opening dashboard…</div></div>';
        // The dashboard caches /api/cost-summary (and friends) in sessionStorage keyed only
        // by date range (see index.html's CACHE_PREFIX) — it has no idea which providers were
        // connected when a given entry was cached. Landing back on '/' in this same tab/session
        // would otherwise reuse whatever was cached before this provider got added, silently
        // showing the OLD provider mix's totals until the tab is closed. Clear it here, once,
        // right when we know the provider mix just changed.
        try {
          Object.keys(sessionStorage)
            .filter(function (k) { return k.indexOf('atsCache:v1:') === 0; })
            .forEach(function (k) { sessionStorage.removeItem(k); });
        } catch (e) {
          // sessionStorage unavailable — nothing to clear
        }
        // The "add the other provider" banner's dismissal (index.html's renderConnectNudge)
        // persists forever in localStorage with no expiry, keyed per-origin not per-setup-run
        // — so a dismissal recorded during ANY earlier session (dev testing, a previous
        // provider mix, etc.) silently suppresses the banner on every later run, even though
        // nothing about the current run ever dismissed it. Clear it here too, for the same
        // reason as the sessionStorage cache above: the provider mix just changed, so any
        // prior dismissal is stale and shouldn't carry forward.
        try {
          Object.keys(localStorage)
            .filter(function (k) { return k.indexOf('atsDismissedConnectBanner:v1:') === 0; })
            .forEach(function (k) { localStorage.removeItem(k); });
        } catch (e) {
          // localStorage unavailable — nothing to clear
        }
        // /setup applies the new key(s) to the running process synchronously (see
        // applyProviderKeys server-side) before responding, so there's no relaunch to wait
        // for anymore — the dashboard is already live by the time this response arrives.
        location.href = '/';
      } catch (e) {
        state.saving = false;
        alert('Could not reach the app to save — try again.');
        renderBottom();
      }
    }

    document.getElementById('page-title').textContent = PAGE.title;
    document.getElementById('page-subtitle').textContent = PAGE.subtitle;
    document.getElementById('proceed-btn').addEventListener('click', proceed);
    PAGE.cards.forEach(renderCard);
    renderBottom();
`;

// Onboarding guide shown before the connect-providers page during SETUP_MODE — three
// screens (intro, "get to know your AI spend", "get clear on your data") adapted from the
// Claude Design project "AI Spend Radar setup guide". The design's own 4th screen (connect
// providers, with its own key-entry form/loading/success states) is intentionally NOT
// reproduced here — that's what /connect (setupPageHtml, built earlier this session) already
// does, so every exit point from this guide (intro's "skip the guide", the top-nav "Skip this
// step", step 2's "Continue") navigates to /connect instead of rendering a 4th local screen.
// Same 5 paths as MOSS_ICON_MARK_PATH_D's source file, scaled up via width/height alone —
// viewBox stays the source's native 79x19, so SVG scales the exact same path data rather
// than needing every coordinate hand-multiplied — and recolored from currentColor to a
// fixed near-black, since this nav bar sits on plain white with no ambient text color to
// inherit the way index.html's dark app-bar badge does.
const MOSS_WORDMARK_SVG = MOSS_LOGO_SOURCE_SVG.replace(
  /width="79"/,
  'width="290"',
)
  .replace(/height="19"/, 'height="67"')
  .replace(/fill="currentColor"/g, 'fill="#131212"');

const ONBOARDING_CLIENT_SCRIPT = `
    const ICONS = {
      chevronRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="1em" height="1em"><path d="M9 6l6 6-6 6"/></svg>',
      chevronLeft: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="1em" height="1em"><path d="M15 6l-6 6 6 6"/></svg>',
      chevronUp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="1em" height="1em"><path d="M6 15l6-6 6 6"/></svg>',
      chevronDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="1em" height="1em"><path d="M6 9l6 6 6-6"/></svg>',
      teams: '${TEAMS_ICON_SVG}',
      send: '${SEND_ICON_SVG}',
      dollar: '${DOLLAR_ICON_SVG}',
      addons: '<svg viewBox="0 0 24 24" fill="none" width="1em" height="1em"><path opacity="0.34" d="M5 10H7C9 10 10 9 10 7V5C10 3 9 2 7 2H5C3 2 2 3 2 5V7C2 9 3 10 5 10Z" stroke="currentColor" stroke-width="1.5" stroke-miterlimit="10" stroke-linecap="round" stroke-linejoin="round"/><path d="M17 10H19C21 10 22 9 22 7V5C22 3 21 2 19 2H17C15 2 14 3 14 5V7C14 9 15 10 17 10Z" stroke="currentColor" stroke-width="1.5" stroke-miterlimit="10" stroke-linecap="round" stroke-linejoin="round"/><path opacity="0.34" d="M17 22H19C21 22 22 21 22 19V17C22 15 21 14 19 14H17C15 14 14 15 14 17V19C14 21 15 22 17 22Z" stroke="currentColor" stroke-width="1.5" stroke-miterlimit="10" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 22H7C9 22 10 21 10 19V17C10 15 9 14 7 14H5C3 14 2 15 2 17V19C2 21 3 22 5 22Z" stroke="currentColor" stroke-width="1.5" stroke-miterlimit="10" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      sparkles: '<svg viewBox="0 0 24 24" fill="currentColor" width="1em" height="1em"><path d="M12 3l1.4 4.3L18 9l-4.6 1.7L12 15l-1.4-4.3L6 9l4.6-1.7Z"/><path d="M19 14.5l.6 1.9 1.9.6-1.9.6-.6 1.9-.6-1.9-1.9-.6 1.9-.6Z"/></svg>',
      key: '${KEY_ICON_SVG}',
      repeat: '${REPEAT_ICON_SVG}',
      questionmark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="1em" height="1em"><circle cx="12" cy="12" r="9"/><path d="M9.3 9.5a2.7 2.7 0 1 1 3.8 2.5c-.8.35-1.1.9-1.1 1.65v.4" stroke-linecap="round"/><circle cx="12" cy="17.2" r="0.9" fill="currentColor" stroke="none"/></svg>',
      shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" width="1em" height="1em"><path d="M12 3l7 3.1v4.9c0 5-3.1 8.6-7 10-3.9-1.4-7-5-7-10V6.1Z"/></svg>',
      search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" width="1em" height="1em"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20l-4.35-4.35"/></svg>',
      check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="1em" height="1em"><path d="M4 12.5l5 5L20 6.5"/></svg>',
      crossSmall: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="1em" height="1em"><path d="M6 6l12 12M18 6L6 18"/></svg>',
      lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" width="1em" height="1em"><rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/></svg>',
      code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" width="1em" height="1em"><path d="M9 8l-5 4 5 4"/><path d="M15 8l5 4-5 4"/></svg>',
      externalLink: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="1em" height="1em"><path d="M9 5h10v10"/><path d="M19 5L5 19"/></svg>',
    };
    function icon(name, size) {
      return '<span class="icon" style="font-size:' + (size || 16) + 'px">' + ICONS[name] + '</span>';
    }

    const state = {
      // 0 = intro, 1 = step1, 2 = step2. INITIAL_SCREEN lets a "Back" link from /connect
      // (which is a full page navigation, not a client-side route — this SPA's in-memory
      // state.screen doesn't survive it) land back on step 2 instead of resetting to intro.
      screen: (Number.isInteger(INITIAL_SCREEN) && INITIAL_SCREEN >= 0 && INITIAL_SCREEN <= 2) ? INITIAL_SCREEN : 0,
      tokenBoxOpen: false,
      flipped: [false, false, false, false],
    };

    // A single fixed illustrative dataset (explicitly labeled "Example data" in the UI, not
    // real) — animated with a per-point sine wobble matching the source design's
    // buildChart()/drawChart(), since that's what was actually asked for, not just flourish.
    const CHART_SERIES = [
      { color: "var(--gray-900)", vals: [2100, 320, 380, 2150, 2330, 1960, 2400, 1860, 160, 220, 1980, 2900, 2680, 2420, 2100, 180, 340, 2520, 2620, 2820, 2410, 2460, 160, 600, 2440, 4100, 3280, 2500] },
      { color: "var(--orange-550)", vals: [1600, 200, 300, 1560, 1760, 1340, 1660, 1310, 90, 150, 1490, 2300, 1760, 1700, 1590, 120, 290, 1810, 1860, 1800, 1660, 1700, 110, 450, 1840, 3400, 2540, 1900] },
      { color: "var(--green-550)", vals: [450, 20, 60, 610, 580, 620, 760, 550, 30, 60, 540, 600, 1010, 860, 700, 50, 90, 700, 810, 1060, 700, 760, 40, 130, 540, 750, 680, 586] },
    ];
    const CHART_MAX = 5000;
    const CHART_MARGIN_LEFT = 64;
    function chartX(i) { return CHART_MARGIN_LEFT + (i * (700 - CHART_MARGIN_LEFT)) / 27; }
    function chartY(v) { return 200 - (v / CHART_MAX) * 188; }

    function chartSvg() {
      const rows = CHART_SERIES.map(function (s, si) {
        const dots = s.vals.map(function (v, i) {
          return '<circle class="chart-dot" data-si="' + si + '" data-i="' + i + '" cx="' + chartX(i).toFixed(1) + '" cy="' + chartY(v).toFixed(1) + '" r="2.6" fill="#fff" stroke="' + s.color + '" stroke-width="1.6"/>';
        }).join("");
        return '<path class="chart-path" data-si="' + si + '" fill="none" stroke="' + s.color + '" stroke-width="1.8" stroke-linejoin="round"/>' + dots;
      }).join("");
      const dayNames = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
      const today = new Date();
      const dateLabels = [3, 7, 11, 15, 19, 23, 27].map(function (i) {
        const d = new Date(today);
        d.setDate(d.getDate() - (27 - i));
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        const x = chartX(i).toFixed(1);
        return (
          '<text x="' + x + '" y="222" text-anchor="middle" font-family="inherit" font-size="9" font-weight="700" fill="var(--text-secondary)">' + dayNames[d.getDay()] + "</text>" +
          '<text x="' + x + '" y="235" text-anchor="middle" font-family="inherit" font-size="9" fill="var(--text-label)">' + mm + "/" + dd + "</text>"
        );
      }).join("");
      return (
        '<svg viewBox="0 0 760 246" style="width:100%;display:block">' +
          '<g stroke="var(--gray-135)" stroke-width="1">' +
            '<line x1="' + CHART_MARGIN_LEFT + '" y1="12" x2="700" y2="12"/><line x1="' + CHART_MARGIN_LEFT + '" y1="59" x2="700" y2="59"/>' +
            '<line x1="' + CHART_MARGIN_LEFT + '" y1="106" x2="700" y2="106"/><line x1="' + CHART_MARGIN_LEFT + '" y1="153" x2="700" y2="153"/><line x1="' + CHART_MARGIN_LEFT + '" y1="200" x2="700" y2="200"/>' +
          '</g>' +
          '<g font-family="inherit" font-size="10" fill="var(--text-secondary)" text-anchor="end">' +
            '<text x="' + (CHART_MARGIN_LEFT - 6) + '" y="15">$5.0k</text>' +
            '<text x="' + (CHART_MARGIN_LEFT - 6) + '" y="62">$3,750.00</text>' +
            '<text x="' + (CHART_MARGIN_LEFT - 6) + '" y="109">$2,500.00</text>' +
            '<text x="' + (CHART_MARGIN_LEFT - 6) + '" y="156">$1,250.00</text>' +
            '<text x="' + (CHART_MARGIN_LEFT - 6) + '" y="203">$0.00</text>' +
          '</g>' +
          '<g>' + dateLabels + '</g>' +
          '<g id="chart-g">' + rows + "</g>" +
        "</svg>"
      );
    }

    const CHART_T0 = Date.now();
    function tickChart() {
      const g = document.getElementById("chart-g");
      if (!g) return;
      CHART_SERIES.forEach(function (s, si) {
        const t = (Date.now() - CHART_T0) / 1000;
        let d = "";
        s.vals.forEach(function (v, i) {
          const y = chartY(v) + 3.4 * Math.sin(t * 1.6 + i * 0.55 + si * 1.3);
          d += (i ? "L" : "M") + chartX(i).toFixed(1) + "," + y.toFixed(1);
          const dot = g.querySelector('.chart-dot[data-si="' + si + '"][data-i="' + i + '"]');
          if (dot) dot.setAttribute("cy", y.toFixed(1));
        });
        const path = g.querySelector('.chart-path[data-si="' + si + '"]');
        if (path) path.setAttribute("d", d);
      });
    }
    setInterval(tickChart, 50);

    function legendRow() {
      return (
        '<div style="display:flex;gap:16px;align-items:center">' +
          '<span style="display:flex;align-items:center;gap:6px"><span style="width:8px;height:8px;border-radius:2px;background:var(--gray-900);display:block"></span><span class="body-s" style="color:var(--text-secondary)">Overall</span></span>' +
          '<span style="display:flex;align-items:center;gap:6px"><span style="width:8px;height:8px;border-radius:2px;background:var(--orange-550);display:block"></span><span class="body-s" style="color:var(--text-secondary)">Claude</span></span>' +
          '<span style="display:flex;align-items:center;gap:6px"><span style="width:8px;height:8px;border-radius:2px;background:var(--green-550);display:block"></span><span class="body-s" style="color:var(--text-secondary)">ChatGPT</span></span>' +
        "</div>"
      );
    }

    function navBar() {
      const inGuide = state.screen >= 1;
      const dotColor = function (n) {
        return state.screen === n ? "var(--ui-moss-550)" : state.screen > n ? "var(--ui-moss-200)" : "var(--gray-150)";
      };
      const stepTitles = { 1: "Get to know your AI spend", 2: "Get clear on your data" };
      const middle = inGuide
        ? '<div style="flex:1;display:flex;align-items:center;justify-content:center;gap:12px">' +
            '<span class="body-s" style="color:var(--text-secondary)">Step ' + state.screen + ' of 3</span>' +
            '<div style="display:flex;gap:6px;align-items:center">' +
              '<span style="width:8px;height:8px;border-radius:999px;background:' + dotColor(1) + ';display:block"></span>' +
              '<span style="width:8px;height:8px;border-radius:999px;background:' + dotColor(2) + ';display:block"></span>' +
              '<span style="width:8px;height:8px;border-radius:999px;background:' + dotColor(3) + ';display:block"></span>' +
            "</div>" +
            '<span class="body-s" style="color:var(--text-primary);font-weight:500">' + stepTitles[state.screen] + "</span>" +
          "</div>"
        : '<div style="flex:1"></div>';
      const skipBtn = inGuide && state.screen < 3
        ? '<button type="button" data-action="skip" class="body-m ghost-btn">Skip this step ' + icon("chevronRight", 16) + "</button>"
        : "";
      return (
        '<div class="nav-bar">' + MOSS_WORDMARK + middle + skipBtn + "</div>"
      );
    }

    function introScreen() {
      return (
        '<div class="intro-grid fade-up">' +
          '<div style="display:flex;flex-direction:column;gap:28px;max-width:640px">' +
            '<div style="display:flex;flex-direction:column;gap:12px">' +
              '<span class="eyebrow">Moss AI Token Cost Tracker</span>' +
              '<h2 style="letter-spacing:-0.01em">Start tracking your company\\'s AI token costs in 10 minutes</h2>' +
              '<p class="body-l" style="color:var(--text-secondary);margin:0">We\\'ll guide you through what matters, then help you connect your data.</p>' +
            "</div>" +
            '<div style="display:flex;flex-direction:column;gap:16px">' +
              introItem("01", "Get to know your AI spend", "See what drives your AI bill and which numbers matter.") +
              introItem("02", "Get clear on your data", "See what the tool retrieves and where your data stays.") +
              introItem("03", "Get your providers connected", "Add your admin keys or ask an administrator to provide them.") +
            "</div>" +
            '<div style="display:flex;flex-direction:column;gap:16px">' +
              '<div style="display:flex;align-items:center;gap:16px">' +
                '<button type="button" data-action="start-guide" class="body-m-bold primary-btn">Start step 1 of 3 ' + icon("chevronRight", 16) + "</button>" +
                '<button type="button" data-action="skip-guide" class="body-m ghost-btn" style="padding:8px 10px">Skip the guide and connect providers</button>' +
              "</div>" +
            "</div>" +
          "</div>" +
          '<div style="min-width:0;display:flex;align-items:center">' +
            '<div class="preview-card">' +
              '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;flex-wrap:wrap;border-bottom:1px solid var(--border-default);padding-bottom:10px">' +
                '<span class="body-m-bold" style="font-size:10px">AI token spend by provider</span>' + legendRow() +
              "</div>" +
              chartSvg() +
            "</div>" +
          "</div>" +
        "</div>"
      );
    }

    function introItem(n, title, body) {
      return (
        '<div style="display:flex;gap:20px;align-items:flex-start">' +
          '<span class="step-num">' + n + "</span>" +
          '<div style="display:flex;flex-direction:column;gap:4px;padding-top:2px">' +
            '<span class="h6">' + title + '</span><span class="body-m" style="color:var(--text-secondary)">' + body + "</span>" +
          "</div>" +
        "</div>"
      );
    }

    function flipCard(i, iconName, title, back, iconSize) {
      return (
        '<div class="flip-outer" data-action="flip" data-i="' + i + '">' +
          '<div class="flip-inner' + (state.flipped[i] ? " flipped" : "") + '">' +
            '<div class="flip-face">' +
              '<span class="flip-icon">' + icon(iconName, iconSize || 20) + "</span>" +
              '<span class="body-m-bold" style="text-align:center">' + title + "</span>" +
              '<span class="flip-hint">' + icon("repeat", 18) + "</span>" +
            "</div>" +
            '<div class="flip-face flip-back">' +
              '<span class="eyebrow" style="color:var(--ui-moss-200)">' + title + "</span>" +
              '<span class="body-s" style="color:#fff">' + back + "</span>" +
            "</div>" +
          "</div>" +
        "</div>"
      );
    }

    function step1Screen() {
      return (
        '<div class="content-col fade-up">' +
          '<div style="display:flex;flex-direction:column;gap:16px">' +
            '<span class="eyebrow">Get to know your AI spend</span>' +
            '<h3>AI token costs can start anywhere. The bill lands in finance.</h3>' +
            '<div class="callout">' +
              '<span class="eyebrow" style="color:var(--ui-moss-700)">The finance problem</span>' +
              '<span class="body-m" style="color:var(--ui-moss-900)">AI token costs are hard to follow because ChatGPT and Claude have separate reports that were not built for finance, and any employee or automated workflow can add usage costs on top of seats.</span>' +
              '<span class="body-m" style="color:var(--ui-moss-900)">Finance needs <strong>(1)</strong> one place to track how AI token costs develop and <strong>(2)</strong> one clear way to see what drives AI token costs.</span>' +
            "</div>" +
          "</div>" +

          '<div style="display:flex;flex-direction:column;gap:24px">' +
            '<div style="display:flex;align-items:center;gap:10px">' +
              '<span class="step-digit">01</span><h5>One place to track how AI token costs develop</h5>' +
            "</div>" +
            '<div class="build-row">' +
              buildItem("dollar", "Token cost", "The price depends on the provider, model and token type") +
              buildItem("send", "Usage", "The number of requests sent by people and automated workflows.") +
              buildItem("teams", "Adoption", "The number of people actively using AI tools each day") +
            "</div>" +
            '<div style="display:flex;flex-direction:column;gap:8px">' +
              '<div class="preview-card" style="padding:16px 20px">' +
                '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;flex-wrap:wrap;border-bottom:1px solid var(--border-default);padding-bottom:10px">' +
                  '<span class="body-m-bold">AI token spend by provider &middot; Last 28 days</span>' + legendRow() +
                "</div>" +
                chartSvg() +
              "</div>" +
              '<div class="chart-controls-row">' +
                '<div class="segmented">' +
                  '<button type="button" aria-selected="true">Cost</button>' +
                  '<button type="button" aria-selected="false">Usage</button>' +
                  '<button type="button" aria-selected="false">Adoption</button>' +
                "</div>" +
                '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
                  tagPill("AI model") + tagPill("Product") + tagPill("Team") + tagPill("Top spender") + tagPill("Workflow") +
                "</div>" +
              "</div>" +
            "</div>" +
          "</div>" +

          '<div style="display:flex;flex-direction:column;gap:16px">' +
            '<div style="display:flex;flex-direction:column;gap:4px">' +
              '<div style="display:flex;align-items:center;gap:10px">' +
                '<span class="step-digit">02</span><h5>One clear way to see what drives AI token costs</h5>' +
              "</div>" +
              '<p class="body-s" style="color:var(--text-secondary);margin:0">Flip each card to see how each influences AI token costs.</p>' +
            "</div>" +
            '<div class="flip-grid">' +
              flipCard(0, "addons", "Provider", "AI providers charge different token prices, so the tools teams use most directly shape total AI token costs.") +
              flipCard(1, "sparkles", "AI model", "Models differ in price and capability. Using a more powerful model than the task requires can increase costs without adding value.", 28) +
              flipCard(2, "teams", "Teams and top spenders", "Token use varies by person and team. High usage may reflect valuable work or inefficient habits, so it should be judged in context.") +
              flipCard(3, "key", "API key and workflow", "Automated workflows run without someone clicking each time. An AI agent caught in a loop can quickly generate requests and increase token costs.", 36) +
            "</div>" +
          "</div>" +

          '<div class="collapsible">' +
            '<button type="button" data-action="toggle-token" class="collapsible-head">' + icon("questionmark", 20) +
              '<span class="body-m-bold" style="flex:1">A quick guide to AI tokens and pricing</span>' +
              '<span id="token-chevron">' + icon(state.tokenBoxOpen ? "chevronUp" : "chevronDown", 16) + "</span>" +
            "</button>" +
            '<div class="collapsible-wrap" id="token-collapsible-wrap" style="max-height:' + (state.tokenBoxOpen ? "2000px" : "0") + '">' +
              tokenBoxBody() +
            "</div>" +
          "</div>" +

        "</div>" +
        '<div class="footer-nav"><div class="footer-nav-inner">' +
          '<button type="button" data-action="back" class="body-m secondary-btn">' + icon("chevronLeft", 16) + " Back</button>" +
          '<button type="button" data-action="next" class="body-m-bold primary-btn">Continue to Step 02 ' + icon("chevronRight", 16) + "</button>" +
        "</div></div>"
      );
    }

    function buildItem(iconName, label, desc) {
      return (
        '<div style="display:flex;align-items:center;gap:12px;text-align:left">' +
          '<span class="build-icon">' + icon(iconName, 16) + "</span>" +
          '<div style="display:flex;flex-direction:column;gap:2px;min-width:0">' +
            '<span class="eyebrow">' + label + '</span><span class="body-m-bold" style="font-size:12px">' + desc + "</span>" +
          "</div>" +
        "</div>"
      );
    }

    function tagPill(text) {
      return '<span class="tag-pill">' + text + "</span>";
    }

    function tokenBoxBody() {
      return (
        '<div class="collapsible-body">' +
          '<p class="body-m" style="color:var(--text-secondary);margin:0">Here\\'s the simple version: seat fees are fixed, while AI token costs change with how much AI your company uses.</p>' +
          '<div style="display:flex;flex-direction:column;gap:10px">' +
            '<p class="body-m" style="margin:0"><strong style="font-weight:500">Tokens:</strong> <span style="color:var(--text-secondary)">Tokens are small pieces of text that an AI model reads and writes. They do not match words exactly, but as a rough guide, 100 tokens are about 75 English words.</span></p>' +
            '<p class="body-m" style="margin:0"><strong style="font-weight:500">Input tokens:</strong> <span style="color:var(--text-secondary)">Everything sent to the model, including the prompt, instructions, files and earlier parts of the conversation.</span></p>' +
            '<p class="body-m" style="margin:0"><strong style="font-weight:500">Cached input tokens:</strong> <span style="color:var(--text-secondary)">Input the provider can reuse instead of processing it again. Reusing it is usually cheaper, although creating the cache may cost extra.</span></p>' +
            '<p class="body-m" style="margin:0"><strong style="font-weight:500">Output tokens:</strong> <span style="color:var(--text-secondary)">Everything the model sends back. Output tokens usually cost more than input tokens.</span></p>' +
            '<p class="body-m" style="margin:0"><strong style="font-weight:500">Price per 1 million tokens:</strong> <span style="color:var(--text-secondary)">The price charged for one million tokens. It changes depending on the provider, model and token type.</span></p>' +
          "</div>" +
          '<div class="formula-box">' +
            '<span class="body-m" style="color:var(--ui-moss-900)">This is the core calculation</span>' +
            '<div style="display:flex;flex-direction:column;gap:4px">' +
              '<span class="body-m-bold" style="color:var(--ui-moss-900)">(Input tokens &divide; 1,000,000 &times; input price)</span>' +
              '<span class="body-m-bold" style="color:var(--ui-moss-900)">+ (Cached input tokens &divide; 1,000,000 &times; cached-input price)</span>' +
              '<span class="body-m-bold" style="color:var(--ui-moss-900)">+ (Output tokens &divide; 1,000,000 &times; output price)</span>' +
              '<span class="body-m-bold" style="color:var(--ui-moss-700)">&rarr; AI token cost for the request</span>' +
            "</div>" +
            '<span class="body-s" style="color:var(--ui-moss-900)">There can be a few extra charges, such as cache creation, reasoning or long context, depending on the provider and model.</span>' +
          "</div>" +
        "</div>"
      );
    }

    function retrieveRow(ok, text) {
      return '<div style="display:flex;gap:8px">' + '<span style="color:' + (ok ? "var(--green-450)" : "var(--red-550)") + '">' + icon(ok ? "check" : "crossSmall", 14) + "</span>" + '<span class="body-m" style="color:var(--text-secondary)">' + text + "</span></div>";
    }

    function step2Screen() {
      return (
        '<div class="content-col fade-up">' +
          '<div style="display:flex;flex-direction:column;gap:16px">' +
            '<span class="eyebrow">Get clear on your data</span>' +
            '<h3>Your data stays between your device and your AI providers.</h3>' +
          "</div>" +

          '<div class="advantage-card">' +
            '<div style="display:flex;align-items:center;gap:10px">' + icon("shield", 20) + '<h6>Advantages of this local tool</h6></div>' +
            '<div style="display:flex;flex-direction:column;gap:10px">' +
              bulletRow("Moss never receives or stores your API keys or spend data.", true) + bulletRow("Runs locally and connects directly to your AI providers.") +
              bulletRow("Processes provider data on your computer.") +
              bulletRow("Your IT team can inspect the GitHub code to verify how keys and data are handled.") +
            "</div>" +
          "</div>" +
          '<div style="display:flex;flex-direction:column;gap:16px">' +
            '<div style="display:flex;align-items:center;gap:10px">' + icon("search", 20) + '<h6>What the application retrieves</h6></div>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:24px">' +
              '<div style="display:flex;flex-direction:column;gap:8px">' +
                '<span class="eyebrow" style="color:var(--text-label)">Retrieves</span>' +
                retrieveRow(true, "AI token costs, requests and adoption") + retrieveRow(true, "Providers, products and models") +
                retrieveRow(true, "Teams, users, API keys and workflows") +
              "</div>" +
              '<div style="display:flex;flex-direction:column;gap:8px">' +
                '<span class="eyebrow" style="color:var(--text-label)">Does not retrieve</span>' +
                retrieveRow(false, "Prompts or instructions") + retrieveRow(false, "Model responses or conversations") + retrieveRow(false, "Files or internal documents") +
              "</div>" +
            "</div>" +
          "</div>" +

        "</div>" +
        '<div class="footer-nav"><div class="footer-nav-inner">' +
          '<button type="button" data-action="back" class="body-m secondary-btn">' + icon("chevronLeft", 16) + " Back</button>" +
          '<button type="button" data-action="next" class="body-m-bold primary-btn">Continue to Step 03 ' + icon("chevronRight", 16) + "</button>" +
        "</div></div>"
      );
    }

    function bulletRow(text, strong) {
      return '<div style="display:flex;gap:10px"><span class="bullet-dot"></span><span class="' + (strong ? "body-m-bold" : "body-m") + '" style="color:' + (strong ? "var(--ui-moss-700)" : "var(--text-secondary)") + '">' + text + "</span></div>";
    }

    function render() {
      const body = state.screen === 0 ? introScreen() : state.screen === 1 ? step1Screen() : step2Screen();
      document.getElementById("root").innerHTML = navBar() + '<div class="page-body">' + body + "</div>";
      bind();
    }

    function bind() {
      const root = document.getElementById("root");
      const on = function (action, handler) {
        root.querySelectorAll('[data-action="' + action + '"]').forEach(function (el) {
          el.addEventListener("click", handler);
        });
      };
      on("start-guide", function () { state.screen = 1; render(); });
      on("skip-guide", function () { location.href = "/connect"; });
      on("skip", function () {
        if (state.screen >= 2) location.href = "/connect";
        else { state.screen += 1; render(); }
      });
      on("next", function () {
        if (state.screen >= 2) location.href = "/connect";
        else { state.screen += 1; render(); }
      });
      on("back", function () { state.screen = Math.max(0, state.screen - 1); render(); });
      // Toggles the wrap's own max-height directly (computed from its real content height via
      // scrollHeight) instead of calling render() — a full re-render tears down and rebuilds
      // the ENTIRE page on every click (this isn't React; there's no diffing to limit the
      // blast radius to just the changed subtree), which is what caused the visible
      // flash/scroll-jump. This also gets a real open/close transition for free, which a full
      // re-render never could — replacing an element's innerHTML can't animate into it.
      function toggleCollapsible(openNow, wrapId, chevronId) {
        const wrap = document.getElementById(wrapId);
        const chevronSpan = document.getElementById(chevronId);
        if (chevronSpan) chevronSpan.innerHTML = icon(openNow ? "chevronUp" : "chevronDown", 16);
        if (!wrap) return;
        if (openNow) {
          wrap.style.maxHeight = wrap.scrollHeight + "px";
        } else {
          wrap.style.maxHeight = wrap.scrollHeight + "px";
          requestAnimationFrame(function () {
            wrap.style.maxHeight = "0px";
          });
        }
      }
      on("toggle-token", function () {
        state.tokenBoxOpen = !state.tokenBoxOpen;
        toggleCollapsible(state.tokenBoxOpen, "token-collapsible-wrap", "token-chevron");
      });
      root.querySelectorAll('[data-action="flip"]').forEach(function (el) {
        el.addEventListener("click", function () {
          const i = Number(el.dataset.i);
          state.flipped[i] = !state.flipped[i];
          // Toggle the class on the existing node instead of calling render() — a full
          // re-render recreates this element with "flipped" already applied, so the browser
          // never sees the rotateY(0) -> rotateY(180deg) transition, just an instant swap to
          // the end state. Mutating the live node is what lets the CSS transition actually run.
          const inner = el.querySelector(".flip-inner");
          if (inner) inner.classList.toggle("flipped", state.flipped[i]);
        });
      });
    }

    render();
`;

function onboardingGuideHtml(initialScreen) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Moss: AI Token Cost Tracker</title>
${FAVICON_LINK_TAG}
<style>
  * { box-sizing: border-box; }
  :root {
    --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    --black: #131212; --white: #FFFFFF;
    --gray-110: #F7F7F7; --gray-120: #F1F1F1; --gray-135: #E3E2E2; --gray-150: #CCCCCC;
    --gray-200: #B6B4B4; --gray-300: #8E8B8B; --gray-450: #717171; --gray-550: #5B5858;
    --gray-700: #4A4A4A; --gray-900: #3D3C3C;
    --ui-moss-120: #D6F1E5; --ui-moss-150: #AEE1CC; --ui-moss-200: #7DCBAF; --ui-moss-300: #52AF90;
    --ui-moss-450: #389477; --ui-moss-550: #2B765F; --ui-moss-700: #265F4F; --ui-moss-800: #234F43; --ui-moss-900: #204138;
    --orange-110: #FEF5EF; --orange-150: #F8D5B5; --orange-450: #EB7515; --orange-550: #CC6816; --orange-900: #5C2B06;
    --green-450: #68A83D; --green-550: #458223;
    --red-550: #C13B32;
    --beige-100: #F7F8F5;
    --text-primary: var(--black); --text-secondary: var(--gray-550); --text-link: #1F70CC; --text-label: var(--gray-450);
    --border-default: var(--gray-135); --border-field: var(--gray-150);
    --brand-primary-default: var(--ui-moss-700); --brand-primary-hover: var(--ui-moss-800);
    --radius-4: 4px; --radius-6: 6px; --radius-8: 8px; --radius-max: 999px;
  }
  html, body { margin: 0; padding: 0; background: var(--beige-100); font-family: var(--font); color: var(--text-primary); }
  a { color: var(--text-link); text-decoration: none; }
  a:hover { text-decoration: underline; }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
  .fade-up { animation: fadeUp 320ms cubic-bezier(0.4,0,0.2,1); }

  h2 { font: 500 40px/48px var(--font); letter-spacing: -0.01em; margin: 0; }
  h3 { font: 500 32px/36px var(--font); margin: 0; }
  h5 { font: 500 20px/24px var(--font); margin: 0; }
  h6 { font: 600 18px/24px var(--font); margin: 0; }
  .body-l { font: 400 16px/22px var(--font); }
  .body-m { font: 400 14px/20px var(--font); }
  .body-m-bold { font: 500 14px/20px var(--font); }
  .body-s { font: 400 12px/16px var(--font); }
  .body-s-bold { font: 500 12px/16px var(--font); }
  .eyebrow { font: 600 10px/14px var(--font); text-transform: uppercase; letter-spacing: 0.04em; color: var(--ui-moss-550); display: block; }

  .icon { display: inline-flex; vertical-align: middle; line-height: 0; }
  .icon svg { display: block; width: 1em; height: 1em; }

  .nav-bar { position: sticky; top: 0; z-index: 50; background: var(--white); border-bottom: 1px solid var(--border-default); padding: 0 32px; height: 64px; display: flex; align-items: center; gap: 24px; }
  .nav-bar svg { height: 20px; display: block; width: auto; }
  .ghost-btn { border: none; background: none; color: var(--text-secondary); cursor: pointer; padding: 8px 10px; border-radius: var(--radius-4); display: flex; align-items: center; gap: 6px; font-family: var(--font); }
  .ghost-btn:hover { background: var(--gray-110); color: var(--text-primary); }

  .page-body { max-width: 1240px; margin: 0 auto; padding: 32px; }
  .intro-grid { display: grid; grid-template-columns: minmax(0,1fr) 504px; gap: 48px; }
  .content-col { display: flex; flex-direction: column; gap: 28px; max-width: 860px; margin: 0 auto; padding-bottom: 96px; }

  .step-num { width: 40px; height: 40px; flex: none; border-radius: var(--radius-max); background: var(--ui-moss-120); color: var(--ui-moss-700); display: flex; align-items: center; justify-content: center; font: 600 14px/1 var(--font); }
  .step-digit { flex: none; font: 700 20px/1 var(--font); color: var(--ui-moss-700); letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
  .callout { background: var(--ui-moss-120); border: 1px solid var(--ui-moss-300); border-radius: var(--radius-8); padding: 16px 20px; display: flex; flex-direction: column; gap: 6px; }

  .primary-btn { background: var(--brand-primary-default); color: var(--white); border: none; border-radius: var(--radius-4); padding: 12px 20px; cursor: pointer; display: inline-flex; align-items: center; gap: 8px; font-family: var(--font); }
  .primary-btn:hover { background: var(--brand-primary-hover); }
  .secondary-btn { background: none; border: 1px solid var(--border-field); border-radius: var(--radius-4); padding: 10px 16px; cursor: pointer; color: var(--text-primary); display: inline-flex; align-items: center; gap: 8px; font-family: var(--font); }
  .secondary-btn:hover { background: var(--gray-110); }

  .preview-card { width: 100%; box-sizing: border-box; background: var(--white); border: 1px solid var(--border-default); border-radius: var(--radius-8); padding: 20px; display: flex; flex-direction: column; gap: 12px; }

  .chart-controls-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .segmented { display: inline-flex; align-items: center; padding: 4px; border-radius: var(--radius-8); background: var(--gray-110); border: 1px solid var(--border-default); }
  .segmented button { border: 0; background: transparent; color: var(--text-secondary); min-height: 29px; padding: 6px 12px; border-radius: var(--radius-6); cursor: pointer; font-family: var(--font); font-size: 12px; font-weight: 680; }
  .segmented button:hover { color: var(--text-primary); }
  .segmented button[aria-selected="true"] { color: var(--text-primary); background: var(--white); box-shadow: 0 1px 5px rgba(23, 32, 29, 0.1); }
  .tag-pill { display: inline-flex; align-items: center; background: var(--ui-moss-700); color: var(--white); border-radius: var(--radius-max); padding: 8px 16px; font-size: 12px; font-weight: 600; }

  .build-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; align-items: flex-start; }
  .build-row > div:not(:first-child) { border-left: 1px solid var(--border-default); padding-left: 24px; }
  .build-icon { width: 36px; height: 36px; flex-shrink: 0; border-radius: var(--radius-max); background: var(--ui-moss-120); color: var(--ui-moss-700); display: flex; align-items: center; justify-content: center; }

  .flip-grid { display: grid; grid-template-columns: repeat(4,1fr); gap: 12px; }
  .flip-outer { perspective: 1200px; height: 190px; cursor: pointer; }
  .flip-inner { position: relative; width: 100%; height: 100%; transform-style: preserve-3d; transition: transform 480ms cubic-bezier(0.4,0,0.2,1); }
  .flip-inner.flipped { transform: rotateY(180deg); }
  .flip-face { position: absolute; inset: 0; backface-visibility: hidden; border-radius: var(--radius-8); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 16px; box-sizing: border-box; background: var(--white); border: 1px solid var(--border-default); }
  .flip-icon { width: 44px; height: 44px; border-radius: var(--radius-max); background: var(--ui-moss-120); color: var(--ui-moss-700); display: flex; align-items: center; justify-content: center; }
  .flip-hint { position: absolute; bottom: 14px; right: 14px; color: var(--gray-450); }
  .flip-back { transform: rotateY(180deg); background: var(--ui-moss-700); border: none; justify-content: center; align-items: flex-start; text-align: left; gap: 10px; }

  .collapsible { background: var(--white); border: 1px solid var(--border-default); border-radius: var(--radius-6); overflow: hidden; }
  .collapsible-head { width: 100%; display: flex; align-items: center; gap: 12px; padding: 16px 20px; background: none; border: none; cursor: pointer; font-family: var(--font); text-align: left; color: var(--gray-450); }
  .collapsible-head:hover { background: var(--gray-110); }
  .collapsible-wrap { overflow: hidden; transition: max-height 280ms cubic-bezier(0.4,0,0.2,1); }
  .collapsible-body { padding: 4px 20px 20px 52px; display: flex; flex-direction: column; gap: 16px; }
  .formula-box { background: var(--ui-moss-120); border-radius: var(--radius-6); padding: 16px 20px; display: flex; flex-direction: column; gap: 8px; }

  .footer-nav { position: fixed; left: 0; right: 0; bottom: 0; z-index: 40; background: var(--white); border-top: 1px solid var(--border-default); padding: 0 32px; height: 64px; display: flex; align-items: center; }
  .footer-nav-inner { width: 100%; max-width: 860px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 24px; }

  .advantage-card { background: var(--white); border: 1px solid var(--ui-moss-200); border-radius: var(--radius-8); padding: 20px 24px; display: flex; flex-direction: column; gap: 16px; }
  .bullet-dot { width: 5px; height: 5px; border-radius: var(--radius-max); background: var(--ui-moss-550); flex: none; margin-top: 8px; }

  @media (max-width: 900px) {
    .intro-grid { grid-template-columns: 1fr; }
    .flip-grid { grid-template-columns: repeat(2,1fr); }
    .build-row { grid-template-columns: 1fr; }
    .build-row > div:not(:first-child) { border-left: none; padding-left: 0; }
  }

  .demo-banner { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 10px 24px; background: var(--orange-110); border-bottom: 1px solid var(--orange-150); color: var(--orange-900); font: 600 13px/18px var(--font); }
  .demo-banner-close { flex: none; border: 0; background: none; padding: 0; color: inherit; font: inherit; font-size: 16px; line-height: 1; cursor: pointer; opacity: 0.7; }
  .demo-banner-close:hover { opacity: 1; }
</style>
</head>
<body>
  ${MOCK_MODE ? '<div class="demo-banner"><span>Demo mode - no real API keys needed. Enter "demo" at the connection step. All data shown is mocked.</span><button type="button" class="demo-banner-close" aria-label="Dismiss" onclick="this.closest(\'.demo-banner\').remove()">&times;</button></div>' : ""}
  <div id="root"></div>
  <script>
    const MOSS_WORDMARK = ${JSON.stringify(MOSS_WORDMARK_SVG)};
    const INITIAL_SCREEN = ${JSON.stringify(initialScreen ?? null)};
  </script>
  <script>${ONBOARDING_CLIENT_SCRIPT}</script>
</body>
</html>`;
}

function setupPageHtml(changeProvider) {
  const mode =
    changeProvider === "anthropic"
      ? "change-anthropic"
      : changeProvider === "openai"
        ? "change-openai"
        : ANTHROPIC_ENABLED && !OPENAI_ENABLED
          ? "add-openai"
          : !ANTHROPIC_ENABLED && OPENAI_ENABLED
            ? "add-anthropic"
            : "setup";
  const pageCopy = setupPageCopy(mode);
  const providersJson = JSON.stringify(PROVIDER_COPY).replace(/</g, "\\u003c");
  const pageJson = JSON.stringify(pageCopy).replace(/</g, "\\u003c");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Moss: AI Token Cost Tracker</title>
${FAVICON_LINK_TAG}
<style>
  * { box-sizing: border-box; }
  :root {
    --font: "Systemia", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  }
  body {
    margin: 0;
    font-family: var(--font);
    background: #f7f7f7;
    color: #131212;
  }
  .icon { display: inline-flex; vertical-align: middle; line-height: 0; }
  .icon svg { display: block; width: 1em; height: 1em; }

  .nav-bar { background: #ffffff; border-bottom: 1px solid #e3e2e2; padding: 0 32px; height: 64px; display: flex; align-items: center; }
  .nav-bar-logo svg { height: 20px; display: block; width: auto; }
  .back-link { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; font: 600 13px/18px var(--font); color: #5b5858; text-decoration: none; padding: 8px 10px; border-radius: 6px; }
  .back-link:hover { background: #f1f1f1; color: #131212; }

  .page-wrap { min-height: calc(100vh - 64px); padding: 64px 24px; display: flex; flex-direction: column; align-items: center; gap: 36px; }
  .page-title { font: 600 24px/30px var(--font); color: #131212; text-align: center; }
  .page-subtitle { font: 400 14px/20px var(--font); color: #5b5858; text-align: center; max-width: 520px; margin-top: 8px; }

  .cards-row { display: flex; gap: 24px; align-items: flex-start; flex-wrap: wrap; justify-content: center; }
  .provider-card { width: 440px; max-width: 100%; background: #ffffff; border: 1px solid #e3e2e2; border-radius: 8px; box-shadow: 0 1px 3px rgba(19,18,18,.08); padding: 28px; transition: border-color 160ms ease; }
  .provider-card.connected { border-color: #265f4f; }

  .card-head { display: flex; align-items: center; gap: 12px; }
  .avatar { width: 36px; height: 36px; border-radius: 999px; display: flex; align-items: center; justify-content: center; font: 600 15px/1 var(--font); flex-shrink: 0; }
  .card-name { flex: 1; font: 600 16px/20px var(--font); color: #131212; }
  .connected-tag { display: flex; align-items: center; gap: 5px; font: 600 11px/14px var(--font); color: #265f4f; }

  .card-body { margin-top: 18px; }

  .connected-summary { display: flex; align-items: center; gap: 10px; padding: 12px 14px; background: #f4faf8; border: 1px solid #d6f1e5; border-radius: 6px; color: #265f4f; }
  .connected-key { flex: 1; font: 400 13px/18px ui-monospace, monospace; color: #3d3c3c; }
  .change-btn { display: inline-flex; align-items: center; gap: 5px; background: none; border: none; padding: 4px 6px; border-radius: 6px; font: 600 12px/16px var(--font); color: #5b5858; cursor: pointer; }
  .change-btn:hover { background: #ffffff; }

  .help-center-link { display: inline-flex; align-items: center; gap: 5px; font: 400 12px/16px var(--font); color: #265f4f; text-decoration: none; margin-bottom: 14px; }
  .help-center-link:hover { text-decoration: underline; }

  .field-steps { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
  .field-step-row { display: flex; align-items: flex-start; gap: 10px; font: 400 13px/19px var(--font); color: #3d3c3c; }
  .field-step-num { flex-shrink: 0; width: 22px; height: 22px; border-radius: 999px; background: #d6f1e5; color: #265f4f; font: 600 10.5px/22px var(--font); text-align: center; }
  .field-step-row code { font-family: ui-monospace, monospace; background: #f7f7f7; padding: 1px 5px; border-radius: 4px; border: 1px solid #e3e2e2; font-size: 12px; }
  .step-link { display: inline-flex; align-items: center; gap: 4px; color: #265f4f; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
  .step-link:hover { color: #1a4237; }

  .key-input-wrap { position: relative; }
  .key-input-wrap input { width: 100%; box-sizing: border-box; padding: 10px 68px 10px 12px; border: 1px solid #e3e2e2; border-radius: 4px; font: 400 14px/20px var(--font); color: #131212; background: #ffffff; }
  .key-input-wrap input.input-error { border-color: #d93d36; }
  .key-spinner { position: absolute; right: 38px; top: 50%; transform: translateY(-50%); color: #8e8b8b; display: flex; }
  .spin { animation: ats-spin 0.8s linear infinite; }
  @keyframes ats-spin { to { transform: translateY(-50%) rotate(360deg); } }
  .reveal-btn { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); width: 26px; height: 26px; border: none; background: none; border-radius: 4px; color: #5b5858; cursor: pointer; display: flex; align-items: center; justify-content: center; }
  .reveal-btn:hover { background: #f1f1f1; }
  .key-format-hint { margin-top: 6px; font: 400 11.5px/16px var(--font); color: #8e8b8b; }
  .field-error, .field-error-slot { margin-top: 8px; min-height: 16px; }
  .field-error { display: flex; align-items: flex-start; gap: 6px; font: 400 12px/16px var(--font); color: #d93d36; }

  .field-note { display: flex; align-items: flex-start; gap: 6px; margin-top: 10px; font: 400 11.5px/16px var(--font); color: #8e8b8b; }
  .field-note .icon { margin-top: 1px; flex-shrink: 0; }

  .delegate-toggle-btn { display: inline-flex; align-items: center; gap: 6px; margin-top: 12px; background: none; border: none; padding: 0; font: 600 12px/16px var(--font); color: #265f4f; cursor: pointer; }
  .delegate-toggle-btn:hover { text-decoration: underline; }
  .delegate-intro { font: 400 13px/18px var(--font); color: #5b5858; margin: 14px 0 10px; }
  .message-card { border: 1px solid #e3e2e2; border-radius: 8px; background: #f7f7f7; overflow: hidden; margin-bottom: 14px; }
  .message-card-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: #ffffff; border-bottom: 1px solid #e3e2e2; }
  .message-card-head .icon { color: #5b5858; }
  .message-card-title { font: 600 11px/14px var(--font); color: #131212; }
  .copy-btn { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; padding: 4px 8px; border: 1px solid #e3e2e2; border-radius: 6px; background: #ffffff; font: 600 11px/14px var(--font); color: #131212; cursor: pointer; }
  .copy-btn-done { border-color: #265f4f; color: #265f4f; }
  .message-card-body { padding: 12px 14px; font: 400 11.5px/1.6 ui-monospace, monospace; color: #3d3c3c; white-space: pre-wrap; }
  .reassurance { font: 400 11.5px/16px var(--font); color: #8e8b8b; margin: -8px 0 14px; }

  .proceed-col { display: flex; flex-direction: column; align-items: center; gap: 8px; }
  .proceed-col button { min-width: 240px; padding: 13px 28px; background: #265f4f; color: #ffffff; border: none; border-radius: 8px; font: 600 15px/20px var(--font); cursor: pointer; }
  .proceed-col button:disabled { background: #e3e2e2; color: #8e8b8b; cursor: not-allowed; }
  .proceed-hint { font: 400 12px/16px var(--font); color: #8e8b8b; }

  .footer-nav { position: fixed; left: 0; right: 0; bottom: 0; z-index: 40; background: #ffffff; border-top: 1px solid #e3e2e2; padding: 0 24px; height: 64px; display: flex; align-items: center; }
  .footer-nav-inner { width: 100%; max-width: 904px; margin: 0 auto; display: flex; align-items: center; }
  .back-btn { display: inline-flex; align-items: center; gap: 8px; background: #ffffff; border: 1px solid #cccccc; border-radius: 8px; padding: 10px 16px; font: 600 14px/20px var(--font); color: #131212; text-decoration: none; cursor: pointer; }
  .back-btn:hover { background: #f7f7f7; }

  .done-wrap { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; }
  .done-title { font: 600 20px/26px var(--font); color: #131212; display: flex; align-items: center; gap: 8px; }
  .done-sub { font: 400 13px/18px var(--font); color: #5b5858; }

  .demo-banner { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 10px 24px; background: #fef5ef; border-bottom: 1px solid #f8d5b5; color: #5c2b06; font: 600 13px/18px var(--font); }
  .demo-banner-close { flex: none; border: 0; background: none; padding: 0; color: inherit; font: inherit; font-size: 16px; line-height: 1; cursor: pointer; opacity: 0.7; }
  .demo-banner-close:hover { opacity: 1; }
</style>
</head>
<body>
  <script type="application/json" id="providers-data">${providersJson}</script>
  <script type="application/json" id="page-data">${pageJson}</script>
  ${MOCK_MODE ? '<div class="demo-banner"><span>No API key yet? Enter &ldquo;demo&rdquo; to explore with example data. It is always possible to add API keys at a later stage.</span><button type="button" class="demo-banner-close" aria-label="Dismiss" onclick="this.closest(\'.demo-banner\').remove()">&times;</button></div>' : ""}
  <div class="nav-bar">
    <span class="nav-bar-logo">${MOSS_WORDMARK_SVG}</span>
    ${
      mode === "setup"
        ? '<div style="flex:1;display:flex;align-items:center;justify-content:center;gap:12px">' +
            '<span style="font:400 12px/16px var(--font);color:#5b5858">Step 3 of 3</span>' +
            '<div style="display:flex;gap:6px;align-items:center">' +
              '<span style="width:8px;height:8px;border-radius:999px;background:#aee1cc;display:block"></span>' +
              '<span style="width:8px;height:8px;border-radius:999px;background:#aee1cc;display:block"></span>' +
              '<span style="width:8px;height:8px;border-radius:999px;background:#265f4f;display:block"></span>' +
            "</div>" +
            '<span style="font:500 12px/16px var(--font);color:#131212">Get your providers connected</span>' +
          "</div>"
        : ""
    }
    ${
      mode === "setup"
        ? ""
        : // "add-*"/"change-*" modes are only ever reached from an already-running dashboard
          // (the connect-provider nudge, or the header's "Change key" action) — without this,
          // changing your mind here means falling back to the browser's own back button.
          '<a href="/" class="back-link"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;display:block"><path d="M15 6l-6 6 6 6"/></svg>Back to dashboard</a>'
    }
  </div>
  <div class="page-wrap" style="${mode === "setup" ? "padding-bottom:96px;" : ""}">
    <div>
      <div class="page-title" id="page-title"></div>
      <div class="page-subtitle" id="page-subtitle"></div>
    </div>
    <div class="cards-row">
      ${pageCopy.cards.map((key) => `<div class="provider-card" id="card-${key}"></div>`).join("\n      ")}
    </div>
    <div class="proceed-col">
      <button type="button" id="proceed-btn" disabled>${pageCopy.buttonLabel}</button>
      <div class="proceed-hint" id="proceed-hint">${pageCopy.cards.length > 1 ? "" : "Paste your key to continue."}</div>
    </div>
  </div>
  ${
    mode === "setup"
      ? '<div class="footer-nav"><div class="footer-nav-inner"><a href="/?step=2" class="back-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;display:block"><path d="M15 6l-6 6 6 6"/></svg>Back</a></div></div>'
      : ""
  }
  <script>${SETUP_CLIENT_SCRIPT}</script>
</body>
</html>`;
}

// Fast, no-retry live check that a pasted key actually authenticates — deliberately
// bypasses cachedFetchJson's 429 backoff/retry loop (a setup check should fail fast, not
// hang the form through several retry cycles). Returns null when the key looks valid, or a
// user-facing message otherwise. A network-level failure (can't reach the API at all)
// returns null too — a flaky connection at setup time shouldn't block an otherwise-valid key.
export async function verifyKey(
  providerName,
  url,
  headers,
  permissionErrorMsg,
) {
  let response;
  try {
    response = await fetch(url, { headers });
  } catch {
    return null;
  }
  if (response.status === 401) {
    return `That ${providerName} key was rejected - double-check you copied the whole value.`;
  }
  if (response.status === 403) {
    return permissionErrorMsg;
  }
  return null;
}

// Shared live-verification for both the per-field /verify-key check and the final /setup
// save — same real API call either way, just triggered at different times.
async function verifyProviderKey(provider, key) {
  // Demo build: any non-empty string "verifies" instantly — no real network call, so the
  // key's actual content is never checked or used for anything.
  if (MOCK_MODE)
    return key.trim()
      ? { ok: true }
      : { ok: false, error: "A key is required" };
  if (provider === "anthropic") {
    const url = new URL(`${API_BASE}/summaries`);
    url.searchParams.set(
      "starting_date",
      new Date().toISOString().slice(0, 10),
    );
    const error = await verifyKey(
      "Anthropic",
      url,
      { "x-api-key": key, "anthropic-version": "2023-06-01" },
      PROVIDER_COPY.anthropic.permissionErrorMsg,
    );
    return error ? { ok: false, error } : { ok: true };
  }
  if (provider === "openai") {
    const url = new URL(`${OPENAI_API_BASE}/costs`);
    url.searchParams.set("limit", "1");
    const error = await verifyKey(
      "OpenAI",
      url,
      { Authorization: `Bearer ${key}` },
      PROVIDER_COPY.openai.permissionErrorMsg,
    );
    return error ? { ok: false, error } : { ok: true };
  }
  return { ok: false, error: "Unknown provider" };
}

async function handleVerifyKey(req, res) {
  let body = "";
  for await (const chunk of req) body += chunk;
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return sendJson(res, 400, { valid: false, error: "Invalid request body" });
  }
  const provider =
    payload.provider === "openai" || payload.provider === "anthropic"
      ? payload.provider
      : null;
  const key = String(payload.key ?? "").trim();
  if (!provider)
    return sendJson(res, 400, { valid: false, error: "Unknown provider" });
  if (!key)
    return sendJson(res, 400, { valid: false, error: "Key is required" });
  const result = await verifyProviderKey(provider, key);
  sendJson(res, 200, {
    valid: result.ok,
    error: result.ok ? null : result.error,
  });
}

// Merge with whatever's already configured rather than overwriting outright — /setup isn't
// just for first-run setup (a live dashboard adding its second provider submits only ONE
// key), and naively writing just that key would silently delete the other, already-working
// one from .env. Pulled out as its own pure function (rather than left inline in handleSetup)
// specifically so this merge logic — the exact bug fixed here previously — can be unit
// tested without also exercising handleSetup's live network verification and filesystem
// write.
export function resolveKeysToPersist({
  anthropicKey,
  openaiKey,
  anthropicEnabled,
  openaiEnabled,
  existingAnthropicKey,
  existingOpenaiKey,
}) {
  return {
    finalAnthropicKey:
      anthropicKey || (anthropicEnabled ? existingAnthropicKey : ""),
    finalOpenaiKey: openaiKey || (openaiEnabled ? existingOpenaiKey : ""),
  };
}

async function handleSetup(req, res) {
  let body = "";
  for await (const chunk of req) body += chunk;
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return sendJson(res, 400, { error: "Invalid request body" });
  }
  const anthropicKey = String(payload.anthropicKey ?? "").trim();
  const openaiKey = String(payload.openaiKey ?? "").trim();
  if (!anthropicKey && !openaiKey) {
    return sendJson(res, 400, {
      error: "At least one provider's API key is required",
    });
  }

  if (anthropicKey) {
    const result = await verifyProviderKey("anthropic", anthropicKey);
    if (!result.ok)
      return sendJson(res, 400, { error: result.error, field: "anthropic" });
  }

  if (openaiKey) {
    const result = await verifyProviderKey("openai", openaiKey);
    if (!result.ok)
      return sendJson(res, 400, { error: result.error, field: "openai" });
  }

  const { finalAnthropicKey, finalOpenaiKey } = resolveKeysToPersist({
    anthropicKey,
    openaiKey,
    anthropicEnabled: ANTHROPIC_ENABLED,
    openaiEnabled: OPENAI_ENABLED,
    existingAnthropicKey: KEY,
    existingOpenaiKey: OPENAI_KEY,
  });
  applyProviderKeys(finalAnthropicKey, finalOpenaiKey);
  sendJson(res, 200, { ok: true });
}

async function handleRemoveKey(req, res) {
  let body = "";
  for await (const chunk of req) body += chunk;
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return sendJson(res, 400, { error: "Invalid request body" });
  }
  const provider = payload.provider;
  if (provider !== "anthropic" && provider !== "openai") {
    return sendJson(res, 400, { error: "Unknown provider" });
  }
  console.log(`Removing ${provider} key...`);
  applyProviderKeys(
    provider === "anthropic" ? "" : KEY,
    provider === "openai" ? "" : OPENAI_KEY,
  );
  sendJson(res, 200, { ok: true });
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "POST" && url.pathname === "/quit") {
      sendJson(res, 200, { ok: true });
      return setTimeout(shutdown, 200);
    }
    // /setup, /verify-key, /remove-key, and /connect are NOT gated on SETUP_MODE — a live
    // dashboard running on just one provider needs to be able to add, change, or remove a
    // key without a full reset, not just during first-run setup.
    if (req.method === "POST" && url.pathname === "/setup")
      return await handleSetup(req, res);
    if (req.method === "POST" && url.pathname === "/verify-key")
      return await handleVerifyKey(req, res);
    if (req.method === "POST" && url.pathname === "/remove-key")
      return await handleRemoveKey(req, res);
    if (url.pathname === "/connect") {
      // ?provider=X (from the dashboard's "Change key" action) explicitly targets an
      // already-connected provider's card, which otherwise wouldn't be reachable here —
      // without it, this route only ever shows whichever provider ISN'T connected yet.
      const requestedProvider = url.searchParams.get("provider");
      const changeProvider =
        (requestedProvider === "anthropic" && ANTHROPIC_ENABLED) ||
        (requestedProvider === "openai" && OPENAI_ENABLED)
          ? requestedProvider
          : null;
      if (!changeProvider && ANTHROPIC_ENABLED && OPENAI_ENABLED) {
        // Both already configured and no specific one was asked for — nothing left to add.
        res.writeHead(302, { Location: "/" });
        return res.end();
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(setupPageHtml(changeProvider));
    }
    if (isSetupMode()) {
      // The onboarding guide (intro + "get to know your spend" + "get clear on your data")
      // is everything BEFORE connecting providers; every exit point from it (skip the guide,
      // skip a step, finish step 2) navigates to /connect (handled above) rather than
      // rendering a 4th local screen, since that key-entry page already does that job.
      // ?step= lets /connect's "Back" link return here at step 2 instead of resetting to the
      // intro — a full page navigation loses this SPA's in-memory state.screen otherwise.
      const stepParam = url.searchParams.get("step");
      const requestedStep = stepParam === null ? NaN : Number(stepParam);
      const initialScreen = Number.isInteger(requestedStep) && requestedStep >= 0 && requestedStep <= 2 ? requestedStep : null;
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(onboardingGuideHtml(initialScreen));
    }
    if (url.pathname === "/api/cost-summary")
      return await handleCostSummary(res, url.searchParams);
    if (url.pathname === "/api/people")
      return await handlePeople(res, url.searchParams);
    if (url.pathname === "/api/efficiency")
      return await handleEfficiency(res, url.searchParams);
    if (url.pathname === "/api/efficiency-by-model")
      return await handleEfficiencyByModel(res, url.searchParams);
    if (url.pathname === "/api/teams")
      return await handleTeams(res, url.searchParams);
    if (url.pathname === "/api/seats")
      return await handleSeats(res, url.searchParams);
    if (url.pathname === "/api/segments")
      return await handleSegments(res, url.searchParams);
    if (url.pathname === "/api/tool-acceptance")
      return await handleToolAcceptance(res, url.searchParams);
    if (url.pathname === "/api/skills")
      return await handleSkills(res, url.searchParams);
    if (url.pathname === "/api/openai-projects")
      return await handleOpenAiProjects(res, url.searchParams);
    return await serveStatic(req, res, url.pathname);
  } catch (error) {
    if (error.code === "ENOENT") {
      res.writeHead(404);
      return res.end("Not found");
    }
    console.error(error);
    sendJson(res, 500, { error: String(error.message ?? error) });
  }
});

// A packaged build has no terminal to surface a crash in — an unhandled EADDRINUSE (e.g.
// a leftover instance of this same app still running) would otherwise just make the app
// silently vanish from the dock with no explanation. Fall forward to the next few ports
// instead of failing; dev mode almost never needs this, but behaves the same way if it did.
function listenWithFallback(port, attemptsLeft) {
  // Deliberately not passed as the 3rd arg to .listen() — that form registers the callback
  // as a one-time "listening" listener that Node does NOT clean up if this attempt fails,
  // so it would still fire (logging the wrong port) once a later retry actually succeeds.
  const onListening = () => {
    server.removeListener("error", onError);
    writeFileSync(PID_FILE, String(process.pid));
    console.log(`AI token spend dashboard running at http://localhost:${port}`);
    // Packaged builds are launched by double-clicking, with no terminal to read this URL
    // from — dev mode (npm start) is unaffected, so re-running the dev server repeatedly
    // doesn't keep popping open new browser tabs.
    if (isSea() && process.platform === "darwin") {
      spawn("open", [`http://localhost:${port}`], { stdio: "ignore" }).unref();
    } else if (isSea() && process.platform === "win32") {
      // explorer.exe hands off a URL to the default browser — more reliable here than
      // `cmd /c start`, which needs a dummy "" title argument to avoid mis-parsing the URL
      // as the window title.
      spawn("explorer", [`http://localhost:${port}`], {
        stdio: "ignore",
      }).unref();
    }
  };
  const onError = (err) => {
    server.removeListener("listening", onListening);
    if (err.code === "EADDRINUSE" && attemptsLeft > 0) {
      console.warn(`Port ${port} is already in use, trying ${port + 1}...`);
      listenWithFallback(port + 1, attemptsLeft - 1);
    } else {
      console.error(err);
      process.exit(1);
    }
  };
  server.once("listening", onListening);
  server.once("error", onError);
  server.listen(port, "127.0.0.1");
}

// A packaged app has no menu bar/Cmd+Q of its own — the polite "Quit" Apple Event the Dock
// sends isn't something a bare Node process understands, so without this, only Force Quit
// (which skips straight to SIGKILL) actually stops it. Handling SIGTERM covers that; /quit
// itself is also still used by reset-onboarding.sh to restart the server cleanly.
function shutdown() {
  try {
    if (readFileSync(PID_FILE, "utf8").trim() === String(process.pid)) {
      unlinkSync(PID_FILE);
    }
  } catch {
    // no pidfile, or it's not ours (a newer instance already overwrote it) — leave it alone
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
// Importing this file (e.g. from a unit test) must not bind a real port or install signal
// handlers — only actually start the server when this file is the process's entry point:
// the packaged SEA build (isSea() is only ever true there) or a direct `node server.mjs` /
// `npm start` invocation.
const isMainModule =
  isSea() ||
  (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]);
if (isMainModule) {
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await killStalePreviousInstance();
  listenWithFallback(PORT, 9);
}
