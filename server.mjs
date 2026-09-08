// Local backend for the AI token spend dashboard.
// Holds ANTHROPIC_ADMIN_KEY server-side and proxies the Claude Enterprise
// Analytics API so the browser never sees the key or calls api.anthropic.com
// directly (that endpoint has no CORS support anyway).
//
// Usage: node --env-file=.env server.mjs

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
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
const KEY = process.env.ANTHROPIC_ADMIN_KEY;
const ANTHROPIC_ENABLED = Boolean(KEY);
const OPENAI_KEY = process.env.OPENAI_ADMIN_KEY;
const OPENAI_ENABLED = Boolean(OPENAI_KEY);

// Rather than exiting, an unconfigured packaged build serves a setup page until at least one
// key is saved — a non-technical user double-clicking an app has no terminal to read an error
// in.
const SETUP_MODE = !ANTHROPIC_ENABLED && !OPENAI_ENABLED;
if (SETUP_MODE) {
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
const HEADERS = { "x-api-key": KEY, "anthropic-version": "2023-06-01" };
const OPENAI_API_BASE = "https://api.openai.com/v1/organization";
const OPENAI_HEADERS = { Authorization: `Bearer ${OPENAI_KEY}` };
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
  // Only ever true for the demo build (see build-mac-demo.sh) — real builds serve this file
  // byte-for-byte unchanged. index.html reads this flag to show a persistent "Demo — sample
  // data" badge so mock data is never mistaken for a real connected account.
  if (!MOCK_MODE) return html;
  return html.replace(
    "</head>",
    "<script>window.__ATS_MOCK_MODE__=true;</script></head>",
  );
}

async function serveStatic(req, res, pathname) {
  if (pathname === "/" || pathname === "/index.html") {
    const content = await loadIndexHtml();
    res.writeHead(200, { "Content-Type": "text/html" });
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
    selfBlurb:
      "Takes about 2 minutes if you're the primary owner of your Anthropic organization.",
    delegateBlurb:
      "We'll draft a message you can send to your organization's primary owner.",
    consoleUrl: "https://claude.ai/admin-settings/api-access",
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
    fieldLabelDelegate: "Once you have the key, paste it here",
    reservedNote:
      "This key only grants read:analytics access — it can read usage and cost data but can't make any changes to your account.",
    delegateIntro: "Send this to your organization's primary owner:",
    messageCardTitle: "Message for your Anthropic org owner",
    invalidFormatMsg:
      "That doesn't look like an Anthropic key — double-check what they sent, or that you copied the whole value.",
    permissionErrorMsg:
      "This Anthropic key doesn't have the right access. Ask whoever created it to generate an Analytics API key, not a regular API key.",
    requestMessage:
      "Hi — I'm setting up AI Spend Control to track our Anthropic (Claude) spend. Could you create an Analytics API key for our organization? (Only the primary owner of the organization can do this.)\n\n" +
      "1. Go to https://claude.ai/admin-settings/api-access\n" +
      "2. Turn on public API access if it isn't already\n" +
      "3. Create an Analytics API key\n" +
      "4. Copy the key and send it to me somewhere secure\n\n" +
      "This key only grants read:analytics access — it can't make any changes to the account.",
  },
  openai: {
    title: "Add OpenAI (ChatGPT) Admin API key",
    shortName: "OpenAI",
    credentialName: "Admin API key",
    badgeBg: "#f1f1f1",
    badgeFg: "#5b5858",
    intro:
      "Add this to see combined spend across both providers. You can always add it later from settings.",
    selfBlurb:
      "Takes about 2 minutes if you have admin access to the OpenAI Platform.",
    delegateBlurb:
      "We'll draft a message you can send to whoever manages your OpenAI account.",
    consoleUrl: "https://platform.openai.com/settings/organization/admin-keys",
    keyPrefix: "sk-",
    steps: [
      { text: "Go to your OpenAI Platform admin keys page.", chip: true },
      { text: "Click <b>Create new admin key</b>." },
      {
        text: "If it asks you to choose permissions, select <b>Read only</b> — then copy the key and paste it below either way.",
      },
    ],
    fieldLabelSelf: "OpenAI Admin API key",
    fieldLabelDelegate: "Once you have the key, paste it here",
    reservedNote:
      "If you were able to choose Read only permissions, this key can only read spend and usage data — nothing can be changed with it.",
    delegateIntro: "Send this to whoever manages your OpenAI account:",
    messageCardTitle: "Message for your OpenAI admin",
    invalidFormatMsg:
      "That doesn't look like a valid OpenAI key — double-check what your admin sent, or that you copied the whole value.",
    permissionErrorMsg:
      "This OpenAI key doesn't have Admin permissions. Ask whoever created it to generate an Admin API key, not a standard API key.",
    requestMessage:
      "Hi — I'm setting up AI Spend Control to track our OpenAI (ChatGPT) spend. Could you create an Admin API key for our organization?\n\n" +
      "1. Go to https://platform.openai.com/settings/organization/admin-keys\n" +
      '2. Click "Create new admin key"\n' +
      '3. If it asks you to choose permissions, select "Read only" — this key is only used to read spend/usage data\n' +
      "4. Copy the key and send it to me somewhere secure",
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
  return {
    title: "Connect your AI providers",
    subtitle:
      "Connect at least one provider to see your spend. Add both to combine spend across providers.",
    cards: ["anthropic", "openai"],
    buttonLabel: "Open dashboard",
  };
}

const SETUP_CLIENT_SCRIPT = `
    const PROVIDERS = JSON.parse(document.getElementById('providers-data').textContent);
    const PAGE = JSON.parse(document.getElementById('page-data').textContent);

    const ICONS = {
      key: '<svg viewBox="-7 0 32 32" fill="currentColor" width="1em" height="1em"><g transform="rotate(-35 9 16)"><path d="M4.28 20.28c-2.36 0-4.28-1.92-4.28-4.28s1.92-4.28 4.28-4.28c1.48 0 2.88 0.8 3.64 2.040h8c1.24 0 2.28 1 2.28 2.28 0 1.24-1 2.28-2.28 2.28-0.080 0-0.28 0.12-0.44 0.24-0.32 0.2-0.76 0.48-1.36 0.48s-1.040-0.28-1.36-0.48c-0.16-0.12-0.36-0.24-0.44-0.24s-0.28 0.12-0.44 0.24c-0.32 0.2-0.76 0.48-1.36 0.48s-1.040-0.28-1.36-0.48c-0.16-0.12-0.36-0.24-0.44-0.24h-0.8c-0.76 1.2-2.12 1.96-3.64 1.96zM4.28 13.36c-1.44 0-2.64 1.2-2.64 2.64s1.2 2.64 2.64 2.64c1.040 0 1.96-0.6 2.4-1.56 0.12-0.28 0.44-0.48 0.76-0.48h1.28c0.6 0 1.040 0.28 1.36 0.48 0.16 0.12 0.36 0.24 0.44 0.24s0.28-0.12 0.44-0.24c0.32-0.2 0.76-0.48 1.36-0.48s1.040 0.28 1.36 0.48c0.16 0.12 0.36 0.24 0.44 0.24s0.28-0.12 0.44-0.24c0.32-0.2 0.76-0.48 1.36-0.48 0.32 0 0.6-0.28 0.6-0.6s-0.28-0.6-0.6-0.6h-8.48c-0.32 0-0.6-0.2-0.76-0.48-0.4-0.96-1.36-1.56-2.4-1.56zM4.96 16c0 0.486-0.394 0.88-0.88 0.88s-0.88-0.394-0.88-0.88c0-0.486 0.394-0.88 0.88-0.88s0.88 0.394 0.88 0.88z"></path></g></svg>',
      send: '<svg viewBox="0 0 24 24" fill="currentColor" width="1em" height="1em"><g transform="rotate(15 12 12)"><path d="M2.009,10.845a1,1,0,0,0,.849.859l8.258,1.18,1.18,8.258a1,1,0,0,0,1.909.252l7.714-18a1,1,0,0,0-1.313-1.313L2.606,9.8A1,1,0,0,0,2.009,10.845Zm11.762,6.483-.711-4.974,4.976-4.976Zm2.85-11.363-4.974,4.974-4.976-.71Z"></path></g></svg>',
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
      anthropicLogo: '<svg viewBox="0 0 248 248" fill="none" width="1em" height="1em"><path d="M52.4285 162.873L98.7844 136.879L99.5485 134.602L98.7844 133.334H96.4921L88.7237 132.862L62.2346 132.153L39.3113 131.207L17.0249 130.026L11.4214 128.844L6.2 121.873L6.7094 118.447L11.4214 115.257L18.171 115.847L33.0711 116.911L55.485 118.447L71.6586 119.392L95.728 121.873H99.5485L100.058 120.337L98.7844 119.392L97.7656 118.447L74.5877 102.732L49.4995 86.1905L36.3823 76.62L29.3779 71.7757L25.8121 67.2858L24.2839 57.3608L30.6515 50.2716L39.3113 50.8623L41.4763 51.4531L50.2636 58.1879L68.9842 72.7209L93.4357 90.6804L97.0015 93.6343L98.4374 92.6652L98.6571 91.9801L97.0015 89.2625L83.757 65.2772L69.621 40.8192L63.2534 30.6579L61.5978 24.632C60.9565 22.1032 60.579 20.0111 60.579 17.4246L67.8381 7.49965L71.9133 6.19995L81.7193 7.49965L85.7946 11.0443L91.9074 24.9865L101.714 46.8451L116.996 76.62L121.453 85.4816L123.873 93.6343L124.764 96.1155H126.292V94.6976L127.566 77.9197L129.858 57.3608L132.15 30.8942L132.915 23.4505L136.608 14.4708L143.994 9.62643L149.725 12.344L154.437 19.0788L153.8 23.4505L150.998 41.6463L145.522 70.1215L141.957 89.2625H143.994L146.414 86.7813L156.093 74.0206L172.266 53.698L179.398 45.6635L187.803 36.802L193.152 32.5484H203.34L210.726 43.6549L207.415 55.1159L196.972 68.3492L188.312 79.5739L175.896 96.2095L168.191 109.585L168.882 110.689L170.738 110.53L198.755 104.504L213.91 101.787L231.994 98.7149L240.144 102.496L241.036 106.395L237.852 114.311L218.495 119.037L195.826 123.645L162.07 131.592L161.696 131.893L162.137 132.547L177.36 133.925L183.855 134.279H199.774L229.447 136.524L237.215 141.605L241.8 147.867L241.036 152.711L229.065 158.737L213.019 154.956L175.45 145.977L162.587 142.787H160.805V143.85L171.502 154.366L191.242 172.089L215.82 195.011L217.094 200.682L213.91 205.172L210.599 204.699L188.949 188.394L180.544 181.069L161.696 165.118H160.422V166.772L164.752 173.152L187.803 207.771L188.949 218.405L187.294 221.832L181.308 223.959L174.813 222.777L161.187 203.754L147.305 182.486L136.098 163.345L134.745 164.2L128.075 235.42L125.019 239.082L117.887 241.8L111.902 237.31L108.718 229.984L111.902 215.452L115.722 196.547L118.779 181.541L121.58 162.873L123.291 156.636L123.14 156.219L121.773 156.449L107.699 175.752L86.304 204.699L69.3663 222.777L65.291 224.431L58.2867 220.768L58.9235 214.27L62.8713 208.48L86.304 178.705L100.44 160.155L109.551 149.507L109.462 147.967L108.959 147.924L46.6977 188.512L35.6182 189.93L30.7788 185.44L31.4156 178.115L33.7079 175.752L52.4285 162.873Z" fill="#D97757"/></svg>',
      openaiLogo: '<svg viewBox="0 0 24 24" fill="currentColor" width="1em" height="1em"><path d="M22.282 9.821a6 6 0 0 0-.516-4.91 6.05 6.05 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a6 6 0 0 0-3.998 2.9 6.05 6.05 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.05 6.05 0 0 0 6.515 2.9A6 6 0 0 0 13.26 24a6.06 6.06 0 0 0 5.772-4.206 6 6 0 0 0 3.997-2.9 6.06 6.06 0 0 0-.747-7.073M13.26 22.43a4.48 4.48 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.8.8 0 0 0 .392-.681v-6.737l2.02 1.168a.07.07 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494M3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.77.77 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646M2.34 7.896a4.5 4.5 0 0 1 2.366-1.973V11.6a.77.77 0 0 0 .388.677l5.815 3.354-2.02 1.168a.08.08 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855-5.833-3.387L15.119 7.2a.08.08 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667m2.01-3.023-.141-.085-4.774-2.782a.78.78 0 0 0-.785 0L9.409 9.23V6.897a.07.07 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.8.8 0 0 0-.393.681zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5Z"/></svg>',
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
      anthropic: { path: null, key: '', status: 'idle', error: '', reveal: false, copied: false },
      openai: { path: null, key: '', status: 'idle', error: '', reveal: false, copied: false },
      saving: false,
    };

    function cardHeader(key) {
      const p = PROVIDERS[key];
      const s = state[key];
      const showBack = s.status !== 'valid' && s.path !== null;
      const logoIcon = key === 'anthropic' ? 'anthropicLogo' : 'openaiLogo';
      const left = showBack
        ? '<button type="button" class="icon-back-btn" data-action="back">' + icon('chevronLeft', 16) + '</button>'
        : '<div class="avatar" style="background:' + p.badgeBg + ';color:' + p.badgeFg + '">' + icon(logoIcon, 18) + '</div>';
      const connectedTag = s.status === 'valid'
        ? '<div class="connected-tag">' + icon('check', 14) + '<span>Connected</span></div>'
        : '';
      return (
        '<div class="card-head">' + left +
          '<div class="card-name">' + p.shortName + ' (' + (key === 'anthropic' ? 'Claude' : 'ChatGPT') + ')</div>' +
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

    function choiceBlock(key) {
      const p = PROVIDERS[key];
      return (
        '<div class="choice-list">' +
          '<button type="button" class="choice-card choice-card-primary" data-action="path" data-path="self">' +
            '<div class="choice-icon choice-icon-primary">' + icon('key', 26) + '</div>' +
            '<div class="choice-body">' +
              '<div class="choice-title">I can create this myself</div>' +
              '<div class="choice-sub">' + p.selfBlurb + '</div>' +
            '</div>' +
            '<span class="chev">' + icon('chevronRight', 14) + '</span>' +
          '</button>' +
          '<button type="button" class="choice-card" data-action="path" data-path="delegate">' +
            '<div class="choice-icon">' + icon('send', 14) + '</div>' +
            '<div class="choice-body">' +
              '<div class="choice-title">I need to ask someone else</div>' +
              '<div class="choice-sub">' + p.delegateBlurb + '</div>' +
            '</div>' +
            '<span class="chev">' + icon('chevronRight', 14) + '</span>' +
          '</button>' +
        '</div>'
      );
    }

    function fieldSteps(key) {
      const p = PROVIDERS[key];
      return '<div class="field-steps">' + p.steps.map(function (step, i) {
        return (
          '<div class="field-step-row">' +
            '<span class="field-step-num">' + (i + 1) + '</span>' +
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
        '<div class="field-error' + (s.error ? '' : '-slot') + '" id="field-error-' + key + '">' + errHtml + '</div>'
      );
    }

    function fieldNote(key) {
      return '<div class="field-note">' + icon('info', 12) + '<span>' + PROVIDERS[key].reservedNote + '</span></div>';
    }

    function selfBlock(key) {
      return fieldSteps(key) + keyField(key) + fieldNote(key);
    }

    function delegateBlock(key) {
      const p = PROVIDERS[key];
      const s = state[key];
      return (
        '<div class="delegate-intro">' + p.delegateIntro + '</div>' +
        '<div class="message-card">' +
          '<div class="message-card-head">' +
            icon('send', 12) +
            '<span class="message-card-title">Message for your admin</span>' +
            '<button type="button" class="copy-btn' + (s.copied ? ' copy-btn-done' : '') + '" data-action="copy">' +
              icon(s.copied ? 'check' : 'copy', 12) + '<span>' + (s.copied ? 'Copied' : 'Copy') + '</span>' +
            '</button>' +
          '</div>' +
          '<div class="message-card-body">' + escapeHtml(p.requestMessage) + '</div>' +
        '</div>' +
        '<div class="reassurance">This message doesn&#39;t include your key or any account access.</div>' +
        '<div class="field-label-line">' + p.fieldLabelDelegate + ':</div>' +
        keyField(key)
      );
    }

    function cardBody(key) {
      const s = state[key];
      if (s.status === 'valid') return connectedSummary(key);
      if (s.path === 'self') return selfBlock(key);
      if (s.path === 'delegate') return delegateBlock(key);
      return choiceBlock(key);
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
        hint = 'Connect at least one provider to continue.';
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

      el.querySelectorAll('[data-action="path"]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          s.path = btn.dataset.path;
          renderCard(key);
        });
      });

      const backBtn = el.querySelector('[data-action="back"]');
      if (backBtn) backBtn.addEventListener('click', function () {
        s.path = null;
        s.key = '';
        s.status = 'idle';
        s.error = '';
        renderCard(key);
        renderBottom();
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
        // Not location.reload() — that reloads /connect itself, which only exists as a route
        // while SETUP_MODE is true. handleSetup's relaunch flips SETUP_MODE off once the keys
        // are saved, so reloading this same URL 404s; the dashboard now lives at /.
        setTimeout(function () { location.href = '/'; }, 1200);
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
const MOSS_WORDMARK_SVG =
  '<svg width="290" height="67" viewBox="0 0 290 67" fill="none" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M128.928 21.377C132.972 21.377 135.383 24.2547 135.383 29.4656V53.42H144.95V30.3211C144.95 25.2658 146.972 21.377 151.716 21.377C155.76 21.377 158.171 24.2547 158.171 29.4656V53.42H168.048V26.9768C168.048 18.1883 162.527 13.2108 155.216 13.2108C149.772 13.2108 146.272 16.0106 143.938 20.1327H143.472C141.294 15.1551 137.172 13.2108 132.817 13.2108C126.906 13.2108 123.873 16.8661 122.628 19.666H122.162V19.666C122.162 16.4279 119.537 13.8029 116.299 13.8029H114.856H114.047H108.103C107.921 13.8029 107.773 13.951 107.773 14.1338V21.2028C107.773 21.3856 107.921 21.5337 108.103 21.5337H112.284C112.467 21.5337 112.615 21.6819 112.615 21.8647V53.42H122.162V30.3989C122.162 25.7324 123.95 21.377 128.928 21.377Z" fill="#131212"></path>' +
  '<path d="M272.725 53.9648C261.992 53.9648 255.692 48.8317 255.148 41.2098H264.792C265.414 44.0874 267.436 46.7318 272.725 46.7318C277.08 46.7318 279.802 44.7874 279.802 42.0653C279.802 39.8098 277.625 38.7988 274.669 37.9433L267.047 35.9211C260.203 34.0546 256.081 31.2547 256.081 24.955C256.081 16.4776 264.092 13.2111 272.491 13.2111C283.147 13.2111 288.28 18.6553 289.057 25.8883H279.336C279.025 23.0106 276.925 20.4441 272.336 20.4441C268.758 20.4441 265.803 21.9995 265.803 24.7994C265.803 26.9771 267.747 27.9104 270.158 28.6104L278.091 30.6325C286.102 32.7324 289.602 36.3878 289.602 41.7542C289.602 48.5206 283.458 53.9648 272.725 53.9648Z" fill="#131212"></path>' +
  '<path d="M234.843 53.9648C224.111 53.9648 217.811 48.8317 217.266 41.2098H226.91C227.533 44.0874 229.555 46.7318 234.843 46.7318C239.199 46.7318 241.921 44.7874 241.921 42.0653C241.921 39.8098 239.743 38.7988 236.788 37.9433L229.166 35.9211C222.322 34.0546 218.2 31.2547 218.2 24.955C218.2 16.4776 226.211 13.2111 234.61 13.2111C245.265 13.2111 250.398 18.6553 251.176 25.8883H241.454C241.143 23.0106 239.043 20.4441 234.455 20.4441C230.877 20.4441 227.922 21.9995 227.922 24.7994C227.922 26.9771 229.866 27.9104 232.277 28.6104L240.21 30.6325C248.221 32.7324 251.72 36.3878 251.72 41.7542C251.72 48.5206 245.576 53.9648 234.843 53.9648Z" fill="#131212"></path>' +
  '<path d="M193.499 54.0425C182.024 54.0425 173.356 46.4984 173.356 33.5101C173.356 20.5996 182.024 13.2111 193.499 13.2111C204.809 13.2111 213.394 20.2885 213.394 33.5101C213.394 46.4984 205.139 54.0425 193.499 54.0425ZM184.005 33.5101C184.005 40.8209 187.472 46.2651 193.499 46.2651C199.525 46.2651 202.745 40.8209 202.745 33.5101C202.745 26.1216 199.525 21.0663 193.499 21.0663C187.472 21.0663 184.005 26.1216 184.005 33.5101Z" fill="#131212"></path>' +
  '<path fill-rule="evenodd" clip-rule="evenodd" d="M54.3024 6.48735C57.6329 2.50284 62.1604 0.0109863 68.0358 0.0109863H77.8512C78.255 0.0109863 78.5824 0.338346 78.5824 0.742166V45.6836C78.5824 56.9139 69.4784 66.0178 58.2482 66.0178H48.4328C48.0289 66.0178 47.7016 65.6905 47.7016 65.2866V60.0219C47.7016 59.8542 47.4934 59.774 47.3786 59.8961C43.8275 63.6722 38.9012 66.0183 33.1076 66.0183H25.0579C24.654 66.0183 24.3267 65.691 24.3267 65.2871V60.1808C24.3267 60.0141 24.1207 59.9334 24.0052 60.0535C20.466 63.7368 15.5969 66.0174 9.88483 66.0174H0.931802C0.527983 66.0174 0.200623 65.69 0.200623 65.2862V34.9259C0.200623 23.6957 9.30455 14.5917 20.5348 14.5917H29.8076C32.8919 9.66944 38.0215 6.48735 44.6609 6.48735H54.3024ZM68.0358 7.32278H71.6362V45.6836C71.6362 52.8757 65.4402 58.706 58.2482 58.706H55.0134V20.3452C55.0134 13.1531 60.8437 7.32278 68.0358 7.32278ZM47.9481 13.7991H44.6609C37.4688 13.7991 31.6385 19.6295 31.6385 26.8216V58.7065H33.1076C41.1019 58.7065 47.9481 52.2259 47.9481 44.2317V13.7991ZM24.7253 21.9035H20.5348C13.3427 21.9035 7.51242 27.7338 7.51242 34.9259V58.7056H9.88483C17.8791 58.7056 24.7253 52.225 24.7253 44.2307V21.9035Z" fill="#131212"></path>' +
  "</svg>";

const ONBOARDING_CLIENT_SCRIPT = `
    const ICONS = {
      chevronRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="1em" height="1em"><path d="M9 6l6 6-6 6"/></svg>',
      chevronLeft: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="1em" height="1em"><path d="M15 6l-6 6 6 6"/></svg>',
      chevronUp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="1em" height="1em"><path d="M6 15l6-6 6 6"/></svg>',
      chevronDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="1em" height="1em"><path d="M6 9l6 6 6-6"/></svg>',
      teams: '<svg viewBox="0 0 24 24" fill="none" width="1em" height="1em"><path d="M10.1992 12C12.9606 12 15.1992 9.76142 15.1992 7C15.1992 4.23858 12.9606 2 10.1992 2C7.43779 2 5.19922 4.23858 5.19922 7C5.19922 9.76142 7.43779 12 10.1992 12Z" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M1 22C1.57038 20.0332 2.74795 18.2971 4.36438 17.0399C5.98081 15.7827 7.95335 15.0687 10 15C14.12 15 17.63 17.91 19 22" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M17.8205 4.44006C18.5822 4.83059 19.1986 5.45518 19.579 6.22205C19.9594 6.98891 20.0838 7.85753 19.9338 8.70032C19.7838 9.5431 19.3674 10.3155 18.7458 10.9041C18.1243 11.4926 17.3302 11.8662 16.4805 11.97" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M17.3203 14.5701C18.6543 14.91 19.8779 15.5883 20.8729 16.5396C21.868 17.4908 22.6007 18.6827 23.0003 20" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      send: '<svg viewBox="0 0 24 24" fill="currentColor" width="1em" height="1em"><g transform="rotate(15 12 12)"><path d="M2.009,10.845a1,1,0,0,0,.849.859l8.258,1.18,1.18,8.258a1,1,0,0,0,1.909.252l7.714-18a1,1,0,0,0-1.313-1.313L2.606,9.8A1,1,0,0,0,2.009,10.845Zm11.762,6.483-.711-4.974,4.976-4.976Zm2.85-11.363-4.974,4.974-4.976-.71Z"></path></g></svg>',
      dollar: '<svg viewBox="-5 0 24 24" width="1em" height="1em" fill="none"><g fill="currentColor"><g transform="translate(-63,-2917)"><g transform="translate(56,160)"><path d="M13.0000978,2768 C10.3390978,2768 9.00009781,2766.371 9.00009781,2764.5 C9.00009781,2762.691 10.2710978,2761 13.0000978,2761 L13.0000978,2768 Z M19.0000978,2773.5 L19.0000978,2773.5 C19.0000978,2775.309 17.7290978,2777 15.0000978,2777 L15.0000978,2770 C17.6610978,2770 19.0000978,2771.629 19.0000978,2773.5 L19.0000978,2773.5 Z M21.0000978,2773.5 L21.0000978,2773.5 C21.0000978,2770.732 18.9750978,2768 15.0000978,2768 L15.0000978,2761 L17.0000978,2761 C18.1050978,2761 19.0000978,2761.895 19.0000978,2763 L21.0000978,2763 C21.0000978,2760.791 19.2090978,2759 17.0000978,2759 L15.0000978,2759 L15.0000978,2757 L13.0000978,2757 L13.0000978,2759 C9.04209781,2759 7.00009781,2761.722 7.00009781,2764.5 C7.00009781,2767.268 9.02509781,2770 13.0000978,2770 L13.0000978,2777 L11.0000978,2777 C9.89509781,2777 9.00009781,2776.105 9.00009781,2775 L7.00009781,2775 C7.00009781,2777.209 8.79109781,2779 11.0000978,2779 L13.0000978,2779 L13.0000978,2781 L15.0000978,2781 L15.0000978,2779 C18.9580978,2779 21.0000978,2776.278 21.0000978,2773.5 L21.0000978,2773.5 Z"/></g></g></g></svg>',
      addons: '<svg viewBox="0 0 24 24" fill="none" width="1em" height="1em"><path opacity="0.34" d="M5 10H7C9 10 10 9 10 7V5C10 3 9 2 7 2H5C3 2 2 3 2 5V7C2 9 3 10 5 10Z" stroke="currentColor" stroke-width="1.5" stroke-miterlimit="10" stroke-linecap="round" stroke-linejoin="round"/><path d="M17 10H19C21 10 22 9 22 7V5C22 3 21 2 19 2H17C15 2 14 3 14 5V7C14 9 15 10 17 10Z" stroke="currentColor" stroke-width="1.5" stroke-miterlimit="10" stroke-linecap="round" stroke-linejoin="round"/><path opacity="0.34" d="M17 22H19C21 22 22 21 22 19V17C22 15 21 14 19 14H17C15 14 14 15 14 17V19C14 21 15 22 17 22Z" stroke="currentColor" stroke-width="1.5" stroke-miterlimit="10" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 22H7C9 22 10 21 10 19V17C10 15 9 14 7 14H5C3 14 2 15 2 17V19C2 21 3 22 5 22Z" stroke="currentColor" stroke-width="1.5" stroke-miterlimit="10" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      sparkles: '<svg viewBox="0 0 24 24" fill="currentColor" width="1em" height="1em"><path d="M12 3l1.4 4.3L18 9l-4.6 1.7L12 15l-1.4-4.3L6 9l4.6-1.7Z"/><path d="M19 14.5l.6 1.9 1.9.6-1.9.6-.6 1.9-.6-1.9-1.9-.6 1.9-.6Z"/></svg>',
      key: '<svg viewBox="-7 0 32 32" fill="none" width="1em" height="1em"><g transform="rotate(-35 9 16)"><path d="M4.28 20.28c-2.36 0-4.28-1.92-4.28-4.28s1.92-4.28 4.28-4.28c1.48 0 2.88 0.8 3.64 2.040h8c1.24 0 2.28 1 2.28 2.28 0 1.24-1 2.28-2.28 2.28-0.080 0-0.28 0.12-0.44 0.24-0.32 0.2-0.76 0.48-1.36 0.48s-1.040-0.28-1.36-0.48c-0.16-0.12-0.36-0.24-0.44-0.24s-0.28 0.12-0.44 0.24c-0.32 0.2-0.76 0.48-1.36 0.48s-1.040-0.28-1.36-0.48c-0.16-0.12-0.36-0.24-0.44-0.24h-0.8c-0.76 1.2-2.12 1.96-3.64 1.96zM4.28 13.36c-1.44 0-2.64 1.2-2.64 2.64s1.2 2.64 2.64 2.64c1.040 0 1.96-0.6 2.4-1.56 0.12-0.28 0.44-0.48 0.76-0.48h1.28c0.6 0 1.040 0.28 1.36 0.48 0.16 0.12 0.36 0.24 0.44 0.24s0.28-0.12 0.44-0.24c0.32-0.2 0.76-0.48 1.36-0.48s1.040 0.28 1.36 0.48c0.16 0.12 0.36 0.24 0.44 0.24s0.28-0.12 0.44-0.24c0.32-0.2 0.76-0.48 1.36-0.48 0.32 0 0.6-0.28 0.6-0.6s-0.28-0.6-0.6-0.6h-8.48c-0.32 0-0.6-0.2-0.76-0.48-0.4-0.96-1.36-1.56-2.4-1.56zM4.96 16c0 0.486-0.394 0.88-0.88 0.88s-0.88-0.394-0.88-0.88c0-0.486 0.394-0.88 0.88-0.88s0.88 0.394 0.88 0.88z" fill="currentColor"></path></g></svg>',
      repeat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="1em" height="1em"><path d="M4.06189 13C4.02104 12.6724 4 12.3387 4 12C4 7.58172 7.58172 4 12 4C14.5006 4 16.7332 5.14727 18.2002 6.94416M19.9381 11C19.979 11.3276 20 11.6613 20 12C20 16.4183 16.4183 20 12 20C9.61061 20 7.46589 18.9525 6 17.2916M9 17H6V17.2916M18.2002 4V6.94416M18.2002 6.94416V6.99993L15.2002 7M6 20V17.2916"/></svg>',
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
      screen: 0, // 0 = intro, 1 = step1, 2 = step2
      tokenBoxOpen: false,
      dataOpen: false,
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
    function chartX(i) { return 34 + (i * 666) / 27; }
    function chartY(v) { return 200 - (v / CHART_MAX) * 188; }

    function chartSvg() {
      const rows = CHART_SERIES.map(function (s, si) {
        const dots = s.vals.map(function (v, i) {
          return '<circle class="chart-dot" data-si="' + si + '" data-i="' + i + '" cx="' + chartX(i).toFixed(1) + '" cy="' + chartY(v).toFixed(1) + '" r="2.6" fill="#fff" stroke="' + s.color + '" stroke-width="1.6"/>';
        }).join("");
        return '<path class="chart-path" data-si="' + si + '" fill="none" stroke="' + s.color + '" stroke-width="1.8" stroke-linejoin="round"/>' + dots;
      }).join("");
      return (
        '<svg viewBox="0 0 760 220" style="width:100%;display:block">' +
          '<g stroke="var(--gray-135)" stroke-width="1">' +
            '<line x1="34" y1="12" x2="700" y2="12"/><line x1="34" y1="59" x2="700" y2="59"/>' +
            '<line x1="34" y1="106" x2="700" y2="106"/><line x1="34" y1="153" x2="700" y2="153"/><line x1="34" y1="200" x2="700" y2="200"/>' +
          '</g>' +
          '<g font-family="inherit" font-size="10" fill="var(--text-secondary)" text-anchor="end">' +
            '<text x="28" y="15">$5.0k</text><text x="28" y="203">0</text>' +
          '</g>' +
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
          '<span style="display:flex;align-items:center;gap:6px"><span style="width:8px;height:8px;border-radius:999px;background:var(--gray-900);display:block"></span><span class="body-s" style="color:var(--text-secondary)">Overall</span></span>' +
          '<span style="display:flex;align-items:center;gap:6px"><span style="width:8px;height:8px;border-radius:999px;background:var(--orange-550);display:block"></span><span class="body-s" style="color:var(--text-secondary)">Anthropic</span></span>' +
          '<span style="display:flex;align-items:center;gap:6px"><span style="width:8px;height:8px;border-radius:999px;background:var(--green-550);display:block"></span><span class="body-s" style="color:var(--text-secondary)">ChatGPT</span></span>' +
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
              '<span class="eyebrow">AI Spend Radar</span>' +
              '<p class="body-m" style="color:var(--text-secondary);margin:0">See who started the meter and what\\'s driving the bill.</p>' +
              '<h2 style="letter-spacing:-0.01em">Start getting your company\\'s AI spend under control in 10 minutes</h2>' +
              '<p class="body-l" style="color:var(--text-secondary);margin:0">We\\'ll guide you through what matters, then help you connect your data.</p>' +
            "</div>" +
            '<div style="display:flex;flex-direction:column;gap:16px">' +
              introItem("1", "Get to know your AI spend", "See what makes up the bill, which numbers matter, and how to use them to investigate what changed.") +
              introItem("2", "Get clear on your data", "See what the tool fetches, where your data stays, and which setup works best for you and your IT team.") +
              introItem("3", "Get your providers connected", "Find the right admin keys, ask IT for help if needed, and bring Anthropic and ChatGPT into one view.") +
            "</div>" +
            '<div style="display:flex;flex-direction:column;gap:16px">' +
              '<p class="body-s" style="color:var(--text-secondary);margin:0">You can skip any step and return to it later.</p>' +
              '<div style="display:flex;align-items:center;gap:16px">' +
                '<button type="button" data-action="start-guide" class="body-m-bold primary-btn">Put my AI spend on the radar ' + icon("chevronRight", 16) + "</button>" +
                '<button type="button" data-action="skip-guide" class="body-m ghost-btn" style="padding:8px 10px">Skip the guide and connect providers</button>' +
              "</div>" +
            "</div>" +
          "</div>" +
          '<div style="min-width:0;display:flex;align-items:center">' +
            '<div class="preview-card">' +
              '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px">' +
                '<span class="body-m-bold">AI spend by provider</span><span class="body-s" style="color:var(--text-secondary)">Last 28 days</span>' +
              "</div>" +
              legendRow() +
              chartSvg() +
              '<span class="body-s" style="color:var(--text-secondary)">Example data. Your own spend appears here once connected.</span>' +
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
            '<h3>AI spend starts everywhere. The bill lands in finance.</h3>' +
            '<div class="callout">' +
              '<span class="eyebrow" style="color:var(--ui-moss-700)">The finance problem</span>' +
              '<span class="body-m" style="color:var(--ui-moss-900)">With AI, companies pay for seats plus usage that any employee or automated workflow can trigger across providers.</span>' +
              '<span class="body-m" style="color:var(--ui-moss-900)">Finance needs <strong>(1)</strong> one view of how total AI costs are developing and <strong>(2)</strong> a clear way to trace what is driving the bill.</span>' +
            "</div>" +
          "</div>" +

          '<div style="display:flex;flex-direction:column;gap:24px">' +
            '<div style="display:flex;align-items:center;gap:10px">' +
              '<span class="step-digit">01</span><h5>One combined view of how your AI costs develop</h5>' +
            "</div>" +
            '<div class="build-row">' +
              buildItem("dollar", "Token cost", "Provider, model and token type determine the rate") +
              buildItem("send", "Usage", "More requests from people and agents") +
              buildItem("teams", "Adoption", "More people using AI") +
            "</div>" +
            '<div style="display:flex;flex-direction:column;gap:8px">' +
              '<div class="preview-card" style="padding:16px 20px">' +
                '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;flex-wrap:wrap;border-bottom:1px solid var(--border-default);padding-bottom:10px">' +
                  '<span class="body-m-bold">AI spend by provider &middot; Last 28 days</span>' + legendRow() +
                "</div>" +
                chartSvg() +
                '<span class="body-s" style="color:var(--text-secondary)">Example data. Your own spend appears here once connected.</span>' +
              "</div>" +
            "</div>" +
          "</div>" +

          '<div style="display:flex;flex-direction:column;gap:16px">' +
            '<div style="display:flex;flex-direction:column;gap:4px">' +
              '<div style="display:flex;align-items:center;gap:10px">' +
                '<span class="step-digit">02</span><h5>Identify what drove the cost</h5>' +
              "</div>" +
              '<p class="body-s" style="color:var(--text-secondary);margin:0">Flip each card to see how it can move the meter.</p>' +
            "</div>" +
            '<div class="flip-grid">' +
              flipCard(0, "addons", "Product category", "Different tools and use cases create different usage patterns. Automated products can send far more requests than everyday chat.") +
              flipCard(1, "sparkles", "AI model", "Requests can stay flat while spend rises when usage shifts to a more expensive model.", 28) +
              flipCard(2, "teams", "Team and top spender", "Long sessions and repeated retries can raise spend, but individual usage should always be viewed in the context of the person\\'s role and team.") +
              flipCard(3, "key", "API key and workflow", "A single automated workflow or runaway loop can generate large volumes of requests without anyone actively using AI.", 36) +
            "</div>" +
          "</div>" +

          '<div class="collapsible">' +
            '<button type="button" data-action="toggle-token" class="collapsible-head">' + icon("questionmark", 20) +
              '<span class="body-m-bold" style="flex:1">Token concepts and pricing explained in one minute</span>' +
              '<span id="token-chevron">' + icon(state.tokenBoxOpen ? "chevronUp" : "chevronDown", 16) + "</span>" +
            "</button>" +
            '<div class="collapsible-wrap" id="token-collapsible-wrap" style="max-height:' + (state.tokenBoxOpen ? "2000px" : "0") + '">' +
              tokenBoxBody() +
            "</div>" +
          "</div>" +

          '<div class="footer-nav">' +
            '<button type="button" data-action="back" class="body-m secondary-btn">' + icon("chevronLeft", 16) + " Back</button>" +
            '<button type="button" data-action="next" class="body-m-bold primary-btn">Continue: Get clear on your data ' + icon("chevronRight", 16) + "</button>" +
          "</div>" +
        "</div>"
      );
    }

    function buildItem(iconName, label, desc) {
      return (
        '<div style="display:flex;align-items:center;gap:12px;text-align:left">' +
          '<span class="build-icon">' + icon(iconName, 16) + "</span>" +
          '<div style="display:flex;flex-direction:column;gap:2px;min-width:0">' +
            '<span class="eyebrow">' + label + '</span><span class="body-m-bold">' + desc + "</span>" +
          "</div>" +
        "</div>"
      );
    }

    function tokenBoxBody() {
      return (
        '<div class="collapsible-body">' +
          '<p class="body-m" style="color:var(--text-secondary);margin:0">This explains the variable token part of the bill. Seat fees are charged separately.</p>' +
          '<div style="display:flex;flex-direction:column;gap:10px">' +
            '<p class="body-m" style="margin:0"><strong style="font-weight:500">Tokens:</strong> <span style="color:var(--text-secondary)">They are the pieces of text an AI model processes, but they do not map neatly to words: as a rough guide, 100 tokens equal around 75 English words.</span></p>' +
            '<p class="body-m" style="margin:0"><strong style="font-weight:500">Input tokens:</strong> <span style="color:var(--text-secondary)">Everything sent to the model, including the prompt, instructions, files and previous context. More context means more billable input.</span></p>' +
            '<p class="body-m" style="margin:0"><strong style="font-weight:500">Cached input tokens:</strong> <span style="color:var(--text-secondary)">Repeated input that the provider can reuse instead of processing again. Cache reads are usually cheaper, although some providers charge separately to create the cache.</span></p>' +
            '<p class="body-m" style="margin:0"><strong style="font-weight:500">Output tokens:</strong> <span style="color:var(--text-secondary)">Everything the model generates. Output tokens are usually priced higher than input tokens.</span></p>' +
            '<p class="body-m" style="margin:0"><strong style="font-weight:500">Price per 1 million tokens:</strong> <span style="color:var(--text-secondary)">The unit rate applied to each token type. The rate changes depending on the provider and model used.</span></p>' +
          "</div>" +
          '<div class="formula-box">' +
            '<span class="body-m" style="color:var(--ui-moss-900)">For usage priced by tokens, providers commonly calculate the token cost of a request like this:</span>' +
            '<div style="display:flex;flex-direction:column;gap:4px">' +
              '<span class="body-m-bold" style="color:var(--ui-moss-900)">(input tokens &divide; 1,000,000 &times; input rate)</span>' +
              '<span class="body-m-bold" style="color:var(--ui-moss-900)">+ (cached input tokens &divide; 1,000,000 &times; cached-input rate)</span>' +
              '<span class="body-m-bold" style="color:var(--ui-moss-900)">+ (output tokens &divide; 1,000,000 &times; output rate)</span>' +
              '<span class="body-m-bold" style="color:var(--ui-moss-700)">= token cost for the request</span>' +
            "</div>" +
          "</div>" +
          '<p class="body-s" style="color:var(--text-secondary);margin:0">This is the core calculation. Depending on the provider and model, cache creation, reasoning, long context and other features may add separate charges.</p>' +
        "</div>"
      );
    }

    function dataBoxBody() {
      return (
        '<div class="collapsible-body">' +
          '<p class="body-m" style="color:var(--text-secondary);margin:0">Alternatively, you can use the public GitHub version. The security level is the same: both follow the same local data flow, and Moss never receives or stores your API keys, personal or spend data.</p>' +
          '<p class="body-m" style="color:var(--text-secondary);margin:0">The one advantage is that your IT or engineering team can inspect the code and verify exactly what happens to your keys and data. It requires Node.js, a terminal and technical support to set up.</p>' +
          '<a href="https://github.com/getmoss" target="_blank" rel="noopener noreferrer" class="body-m" style="display:flex;align-items:center;gap:6px">View the GitHub repository ' + icon("externalLink", 12) + "</a>" +
        "</div>"
      );
    }

    function retrieveRow(ok, text) {
      return '<div style="display:flex;gap:8px">' + icon(ok ? "check" : "crossSmall", 14) + '<span class="body-m" style="color:var(--text-secondary)">' + text + "</span></div>";
    }

    function step2Screen() {
      return (
        '<div class="content-col fade-up">' +
          '<div style="display:flex;flex-direction:column;gap:16px">' +
            '<span class="eyebrow">Get clear on your data</span>' +
            '<h3>Your data stays between your device and your AI providers.</h3>' +
            '<p class="body-m" style="color:var(--text-secondary);margin:0">AI Spend Radar opens in your browser but runs on your computer. Moss never receives or stores your API keys or spend data.</p>' +
          "</div>" +

          '<div class="two-col">' +
            '<div class="advantage-card">' +
              '<div style="display:flex;align-items:center;gap:10px">' + icon("shield", 20) + '<h6>Advantages of this local tool</h6></div>' +
              '<div style="display:flex;flex-direction:column;gap:10px">' +
                bulletRow("Runs entirely on your computer") + bulletRow("Connects directly to each provider") +
                bulletRow("Keeps your API keys on your device") + bulletRow("Processes all returned data locally") +
                bulletRow("Sends no keys or spend data to Moss") +
              "</div>" +
            "</div>" +
            '<div class="col-divider"></div>' +
            '<div style="display:flex;flex-direction:column;gap:16px">' +
              '<div style="display:flex;align-items:center;gap:10px">' + icon("search", 20) + '<h6>What the application retrieves</h6></div>' +
              '<div style="display:flex;flex-direction:column;gap:8px">' +
                '<span class="eyebrow" style="color:var(--text-label)">Retrieves</span>' +
                retrieveRow(true, "Spend, requests and adoption") + retrieveRow(true, "Products and models") +
                retrieveRow(true, "Teams and users") + retrieveRow(true, "API key and workflow usage") + retrieveRow(true, "Seat utilisation, where available") +
              "</div>" +
              '<div style="display:flex;flex-direction:column;gap:8px">' +
                '<span class="eyebrow" style="color:var(--text-label)">Does not retrieve</span>' +
                retrieveRow(false, "Prompts or instructions") + retrieveRow(false, "Model responses") + retrieveRow(false, "Conversation content") +
              "</div>" +
            "</div>" +
          "</div>" +

          '<div class="collapsible">' +
            '<button type="button" data-action="toggle-data" class="collapsible-head">' + icon("code", 20) +
              '<span class="body-m-bold" style="flex:1">Still have security concerns? Let your IT team verify the setup.</span>' +
              '<span id="data-chevron">' + icon(state.dataOpen ? "chevronUp" : "chevronDown", 16) + "</span>" +
            "</button>" +
            '<div class="collapsible-wrap" id="data-collapsible-wrap" style="max-height:' + (state.dataOpen ? "2000px" : "0") + '">' +
              dataBoxBody() +
            "</div>" +
          "</div>" +

          '<div class="footer-nav">' +
            '<button type="button" data-action="back" class="body-m secondary-btn">' + icon("chevronLeft", 16) + " Back</button>" +
            '<button type="button" data-action="next" class="body-m-bold primary-btn">Continue: Get your providers connected ' + icon("chevronRight", 16) + "</button>" +
          "</div>" +
        "</div>"
      );
    }

    function bulletRow(text) {
      return '<div style="display:flex;gap:10px"><span class="bullet-dot"></span><span class="body-m" style="color:var(--text-secondary)">' + text + "</span></div>";
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
      on("toggle-data", function () {
        state.dataOpen = !state.dataOpen;
        toggleCollapsible(state.dataOpen, "data-collapsible-wrap", "data-chevron");
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

function onboardingGuideHtml() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>AI Spend Radar — Setup guide</title>
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
  .content-col { display: flex; flex-direction: column; gap: 28px; max-width: 860px; margin: 0 auto; }

  .step-num { width: 40px; height: 40px; flex: none; border-radius: var(--radius-max); background: var(--ui-moss-120); color: var(--ui-moss-700); display: flex; align-items: center; justify-content: center; font: 600 14px/1 var(--font); }
  .step-digit { flex: none; font: 700 20px/1 var(--font); color: var(--ui-moss-700); letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
  .callout { background: var(--ui-moss-120); border: 1px solid var(--ui-moss-300); border-radius: var(--radius-8); padding: 16px 20px; display: flex; flex-direction: column; gap: 6px; }

  .primary-btn { background: var(--brand-primary-default); color: var(--white); border: none; border-radius: var(--radius-4); padding: 12px 20px; cursor: pointer; display: inline-flex; align-items: center; gap: 8px; font-family: var(--font); }
  .primary-btn:hover { background: var(--brand-primary-hover); }
  .secondary-btn { background: none; border: 1px solid var(--border-field); border-radius: var(--radius-4); padding: 10px 16px; cursor: pointer; color: var(--text-primary); display: inline-flex; align-items: center; gap: 8px; font-family: var(--font); }
  .secondary-btn:hover { background: var(--gray-110); }

  .preview-card { width: 100%; box-sizing: border-box; background: var(--white); border: 1px solid var(--border-default); border-radius: var(--radius-8); padding: 20px; display: flex; flex-direction: column; gap: 12px; }

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

  .footer-nav { border-top: 1px solid var(--border-default); padding-top: 24px; display: flex; align-items: center; justify-content: space-between; gap: 24px; }

  .two-col { display: grid; grid-template-columns: 1fr 1px 1fr; gap: 32px; align-items: start; }
  .advantage-card { background: var(--white); border: 1px solid var(--ui-moss-200); border-radius: var(--radius-8); padding: 20px 24px; display: flex; flex-direction: column; gap: 16px; }
  .col-divider { background: var(--border-default); width: 1px; align-self: stretch; }
  .bullet-dot { width: 5px; height: 5px; border-radius: var(--radius-max); background: var(--ui-moss-550); flex: none; margin-top: 8px; }

  @media (max-width: 900px) {
    .intro-grid { grid-template-columns: 1fr; }
    .two-col { grid-template-columns: 1fr; }
    .col-divider { display: none; }
    .flip-grid { grid-template-columns: repeat(2,1fr); }
    .build-row { grid-template-columns: 1fr; }
    .build-row > div:not(:first-child) { border-left: none; padding-left: 0; }
  }

  .demo-banner { text-align: center; padding: 10px 24px; background: var(--orange-110); border-bottom: 1px solid var(--orange-150); color: var(--orange-900); font: 600 13px/18px var(--font); }
</style>
</head>
<body>
  ${MOCK_MODE ? '<div class="demo-banner">Demo mode — no real API keys needed. When you reach the connect step, enter anything (e.g. &ldquo;demo&rdquo;) to continue; all data shown is mocked.</div>' : ""}
  <div id="root"></div>
  <script>
    const MOSS_WORDMARK = ${JSON.stringify(MOSS_WORDMARK_SVG)};
  </script>
  <script>${ONBOARDING_CLIENT_SCRIPT}</script>
</body>
</html>`;
}

function setupPageHtml() {
  const mode =
    ANTHROPIC_ENABLED && !OPENAI_ENABLED
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
<title>AI Spend Control — Setup</title>
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
  .icon-back-btn { width: 36px; height: 36px; flex-shrink: 0; border-radius: 999px; background: #f1f1f1; color: #131212; border: none; display: flex; align-items: center; justify-content: center; cursor: pointer; }
  .icon-back-btn:hover { background: #e3e2e2; }
  .card-name { flex: 1; font: 600 16px/20px var(--font); color: #131212; }
  .connected-tag { display: flex; align-items: center; gap: 5px; font: 600 11px/14px var(--font); color: #265f4f; }

  .card-body { margin-top: 18px; }

  .connected-summary { display: flex; align-items: center; gap: 10px; padding: 12px 14px; background: #f4faf8; border: 1px solid #d6f1e5; border-radius: 6px; color: #265f4f; }
  .connected-key { flex: 1; font: 400 13px/18px ui-monospace, monospace; color: #3d3c3c; }
  .change-btn { display: inline-flex; align-items: center; gap: 5px; background: none; border: none; padding: 4px 6px; border-radius: 6px; font: 600 12px/16px var(--font); color: #5b5858; cursor: pointer; }
  .change-btn:hover { background: #ffffff; }

  .choice-list { display: flex; flex-direction: column; gap: 10px; }
  .choice-card { all: unset; display: flex; align-items: flex-start; gap: 12px; width: 100%; box-sizing: border-box; padding: 14px 16px; border: 1px solid #e3e2e2; border-radius: 8px; background: #ffffff; cursor: pointer; font: inherit; color: inherit; }
  .choice-card-primary { border-color: #265f4f; background: #f4faf8; }
  .choice-card:not(.choice-card-primary):hover { background: #f7f7f7; }
  .choice-card-primary:hover { background: #eef8f4; }
  .choice-icon { width: 32px; height: 32px; flex-shrink: 0; border-radius: 999px; background: #f1f1f1; color: #5b5858; display: flex; align-items: center; justify-content: center; }
  .choice-icon-primary { background: #d6f1e5; color: #265f4f; }
  .choice-body { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .choice-title { font: 600 14px/18px var(--font); color: #131212; }
  .choice-sub { font: 400 12px/16px var(--font); color: #5b5858; }
  .chev { color: #8e8b8b; align-self: center; display: flex; }

  .field-steps { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
  .field-step-row { display: flex; align-items: flex-start; gap: 10px; font: 400 13px/19px var(--font); color: #3d3c3c; }
  .field-step-num { flex-shrink: 0; width: 18px; height: 18px; border-radius: 999px; background: #d6f1e5; color: #265f4f; font: 600 11px/18px var(--font); text-align: center; }
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
  .field-error, .field-error-slot { margin-top: 8px; min-height: 16px; }
  .field-error { display: flex; align-items: flex-start; gap: 6px; font: 400 12px/16px var(--font); color: #d93d36; }

  .field-note { display: flex; align-items: flex-start; gap: 6px; margin-top: 10px; font: 400 11.5px/16px var(--font); color: #8e8b8b; }
  .field-note .icon { margin-top: 1px; flex-shrink: 0; }

  .field-label-line { font: 400 13px/18px var(--font); color: #131212; margin: 12px 0 8px; }
  .delegate-intro { font: 400 13px/18px var(--font); color: #5b5858; margin-bottom: 10px; }
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

  .done-wrap { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; }
  .done-title { font: 600 20px/26px var(--font); color: #131212; display: flex; align-items: center; gap: 8px; }
  .done-sub { font: 400 13px/18px var(--font); color: #5b5858; }

  .demo-banner { text-align: center; padding: 10px 24px; background: #fef5ef; border-bottom: 1px solid #f8d5b5; color: #5c2b06; font: 600 13px/18px var(--font); }
</style>
</head>
<body>
  <script type="application/json" id="providers-data">${providersJson}</script>
  <script type="application/json" id="page-data">${pageJson}</script>
  ${MOCK_MODE ? '<div class="demo-banner">Demo mode — no real API keys needed. Enter anything below (e.g. &ldquo;demo&rdquo;) to continue; all data shown is mocked.</div>' : ""}
  <div class="nav-bar">
    <span class="nav-bar-logo">${MOSS_WORDMARK_SVG}</span>
    ${
      mode === "setup"
        ? '<a href="/" class="back-link"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;display:block"><path d="M15 6l-6 6 6 6"/></svg>Back to guide</a>'
        : ""
    }
  </div>
  <div class="page-wrap">
    <div>
      <div class="page-title" id="page-title"></div>
      <div class="page-subtitle" id="page-subtitle"></div>
    </div>
    <div class="cards-row">
      ${pageCopy.cards.map((key) => `<div class="provider-card" id="card-${key}"></div>`).join("\n      ")}
    </div>
    <div class="proceed-col">
      <button type="button" id="proceed-btn" disabled>${pageCopy.buttonLabel}</button>
      <div class="proceed-hint" id="proceed-hint">${pageCopy.cards.length > 1 ? "Connect at least one provider to continue." : "Paste your key to continue."}</div>
    </div>
  </div>
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
// tested without also exercising handleSetup's live network verification, filesystem write,
// and process relaunch.
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
  const lines = [];
  if (finalAnthropicKey) lines.push(`ANTHROPIC_ADMIN_KEY=${finalAnthropicKey}`);
  if (finalOpenaiKey) lines.push(`OPENAI_ADMIN_KEY=${finalOpenaiKey}`);
  writeFileSync(join(ROOT, ".env"), lines.join("\n") + "\n");
  sendJson(res, 200, { ok: true });
  // Relaunch so the freshly-written config loads cleanly instead of trying to hot-swap the
  // KEY/HEADERS constants already baked in at module load. setTimeout gives the response
  // above time to actually flush to the client before this process exits.
  setTimeout(() => {
    const relaunchArgs = isSea()
      ? []
      : process.execArgv.concat(process.argv.slice(1));
    spawn(process.execPath, relaunchArgs, {
      detached: true,
      stdio: "ignore",
    }).unref();
    process.exit(0);
  }, 200);
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "POST" && url.pathname === "/quit") {
      sendJson(res, 200, { ok: true });
      return setTimeout(shutdown, 200);
    }
    // /setup, /verify-key, and /connect are NOT gated on SETUP_MODE — a live dashboard
    // running on just one provider needs to be able to add the other one without a full
    // reset, not just during first-run setup.
    if (req.method === "POST" && url.pathname === "/setup")
      return await handleSetup(req, res);
    if (req.method === "POST" && url.pathname === "/verify-key")
      return await handleVerifyKey(req, res);
    if (url.pathname === "/connect") {
      if (ANTHROPIC_ENABLED && OPENAI_ENABLED) {
        // Both already configured — nothing left to add.
        res.writeHead(302, { Location: "/" });
        return res.end();
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(setupPageHtml());
    }
    if (SETUP_MODE) {
      // The onboarding guide (intro + "get to know your spend" + "get clear on your data")
      // is everything BEFORE connecting providers; every exit point from it (skip the guide,
      // skip a step, finish step 2) navigates to /connect (handled above) rather than
      // rendering a 4th local screen, since that key-entry page already does that job.
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(onboardingGuideHtml());
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
// (which skips straight to SIGKILL) actually stops it. Handling SIGTERM covers that, and
// the dashboard's own Quit button (see index.html) hits /quit for a normal in-app way out.
function shutdown() {
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

  listenWithFallback(PORT, 9);
}
