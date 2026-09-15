// Pure formatting/lookup/comparison helpers shared by index.html's dashboard script.
// Extracted verbatim (same bodies, same names) so they're unit-testable with node --test —
// see test/format.test.mjs. Everything DOM/state-dependent stays in index.html itself.

export const money = (n) => {
  const sign = n < 0 ? "-" : "";
  const v = Math.abs(n);
  if (v >= 1000) return `${sign}$${(v / 1000).toFixed(1)}k`;
  return `${sign}$${v.toFixed(2)}`;
};
export const pct = (n) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
export const signedMoney = (n) => (n >= 0 ? `+${money(n)}` : money(n));
export const signedNumber = (n) =>
  `${n >= 0 ? "+" : "-"}${Math.round(Math.abs(n)).toLocaleString()}`;
export const compactNumber = (n) => {
  const v = Math.abs(n);
  if (v >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return `${Math.round(n)}`;
};

export function pctChange(current, previous) {
  if (previous == null || previous === 0 || current == null) return null;
  return ((current - previous) / previous) * 100;
}

// goodDirection: "up" (higher is better, e.g. seat utilization), "down" (lower is
// better, e.g. spend), or null (neutral — just report the change, no color judgment).
export function trendBadge(
  diffValue,
  { unit = "%", goodDirection = null, extra = "" } = {},
) {
  if (diffValue == null || !Number.isFinite(diffValue)) return "";
  const isUp = diffValue >= 0;
  let cls = "trend-neutral";
  if (goodDirection === "up") cls = isUp ? "trend-good" : "trend-bad";
  if (goodDirection === "down") cls = isUp ? "trend-bad" : "trend-good";
  const arrow = isUp ? "▲" : "▼";
  return `<span class="${cls}">${arrow} ${Math.abs(diffValue).toFixed(1)}${unit}${extra}</span>`;
}

export const productLabel = (p) =>
  ({
    chat: "Chat",
    cowork: "Cowork",
    claude_code: "Claude Code",
    claude_in_chrome: "Claude in Chrome",
    claude_design: "Claude Design",
    office_agent: "Office Agent",
    research: "Research",
    "claude-tag": "Claude in Slack",
    cc_security_autopatch: "Security autopatch",
  })[p] ?? p;

// Rate-card reference for the Model tab only — USD per 1M tokens, from
// platform.claude.com/docs/en/about-claude/pricing (checked 2026-09-01).
// Anthropic-only: our Model breakdown itself is Anthropic-only (no
// per-model OpenAI data source — see Step 6/7 notes), so there's
// nothing to look up for GPT models here yet. Needs occasional manual
// review as Anthropic's pricing changes.
export const MODEL_PRICING = {
  "claude-fable-5": { input: 10, cached: 1, output: 50 },
  "claude-mythos-5": { input: 10, cached: 1, output: 50 },
  "claude-opus-5": { input: 5, cached: 0.5, output: 25 },
  "claude-opus-4-8": { input: 5, cached: 0.5, output: 25 },
  "claude-opus-4-7": { input: 5, cached: 0.5, output: 25 },
  "claude-opus-4-6": { input: 5, cached: 0.5, output: 25 },
  "claude-opus-4-5": { input: 5, cached: 0.5, output: 25 },
  "claude-sonnet-5": { input: 2, cached: 0.2, output: 10 },
  "claude-sonnet-4-6": { input: 3, cached: 0.3, output: 15 },
  "claude-sonnet-4-5": { input: 3, cached: 0.3, output: 15 },
  "claude-haiku-4-5": { input: 1, cached: 0.1, output: 5 },
};
// Model ids sometimes carry a trailing snapshot date (e.g.
// claude-haiku-4-5-20251001) — strip it before matching the table above.
export function modelPricingFor(modelId) {
  return MODEL_PRICING[modelId.replace(/-\d{8}$/, "")] ?? null;
}

// Nulls (e.g. no previous-period data) always sort to the bottom,
// regardless of direction — otherwise ascending sort would surface
// "n/a" rows first, which reads as an error rather than a real row.
export function compareRows(a, b, key, dir) {
  const av = a[key];
  const bv = b[key];
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  return dir === "asc" ? av - bv : bv - av;
}

export function foldOther(series, cap = 6) {
  const named = series.map((s, i) => ({ ...s, colorIndex: i }));
  if (named.length <= cap + 1) return named;
  const top = named.slice(0, cap);
  const rest = named.slice(cap);
  const length = series[0]?.spend.length ?? 0;
  const otherSpend = new Array(length).fill(0);
  let totalSpend = 0,
    requests = 0;
  for (const s of rest) {
    s.spend.forEach((v, i) => {
      otherSpend[i] += v;
    });
    totalSpend += s.totalSpend;
    requests += s.requests;
  }
  top.push({
    name: "Other",
    spend: otherSpend,
    totalSpend,
    requests,
    colorIndex: "other",
  });
  return top;
}

export const isoToday = () => new Date().toISOString().slice(0, 10);
export const isoDaysAgo = (days) =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

// "Expected range" for the Saving opportunities baseline: mean +/- one
// standard deviation across the previous N completed periods. Chosen over
// min/max because min/max treats any past extreme as "still normal" and
// never tightens; mean +/- stddev reacts to a genuine, sustained shift.
// Periods that predate the org's history floor should be filtered out by
// the caller before this runs (same convention as hasFullPreviousPeriod
// elsewhere in server.mjs) — fewer than 2 usable periods can't describe a
// range, so this returns null rather than a misleadingly narrow one.
export function computeBaselineRange(periodSpends) {
  const usable = periodSpends.filter(
    (v) => v != null && Number.isFinite(v),
  );
  if (usable.length < 2) return null;
  const mean = usable.reduce((sum, v) => sum + v, 0) / usable.length;
  const variance =
    usable.reduce((sum, v) => sum + (v - mean) ** 2, 0) / usable.length;
  const stddev = Math.sqrt(variance);
  return {
    mean,
    stddev,
    min: Math.min(...usable),
    max: Math.max(...usable),
    expectedRange: [Math.max(0, mean - stddev), mean + stddev],
    periodsUsed: usable.length,
  };
}

// Spend above the top of the expected range — the headline "spend to
// review" figure. 0 (not negative) when current spend is inside or below
// the range, since being under budget isn't something to flag.
export function computeSpendAboveRange(currentSpend, baselineRange) {
  if (baselineRange == null || currentSpend == null) return null;
  const [, high] = baselineRange.expectedRange;
  const amount = Math.max(0, currentSpend - high);
  return {
    amount,
    percentage: currentSpend > 0 ? (amount / currentSpend) * 100 : 0,
    isAbove: amount > 0,
  };
}

function blendedRateFromBuckets(buckets) {
  const rate = (spend, tokens) =>
    tokens > 0 ? (spend / tokens) * 1_000_000 : null;
  const totalSpend = buckets.reduce((sum, b) => sum + b.spend, 0);
  const totalTokens = buckets.reduce((sum, b) => sum + b.tokens, 0);
  return {
    ratePerMillion: rate(totalSpend, totalTokens),
    totalSpend,
    byTokenType: buckets.map((b) => ({
      type: b.type,
      spend: b.spend,
      tokens: b.tokens,
      ratePerMillion: rate(b.spend, b.tokens),
    })),
  };
}

// Actual blended $/1M tokens this org paid, split into the three token
// types the rate-benchmark UI shows. Cache-creation (write) cost is folded
// into "input" alongside uncached input — both are a first-time processing
// cost, as opposed to a cheap cache read.
// usage: shape from aggregateUsage() (server.mjs) — uncachedInputTokens,
//   cacheReadInputTokens, cacheCreationTokens, outputTokens.
// tokenCosts: Map from fetchCostByTokenType() (server.mjs), dollar amounts
//   keyed by Anthropic's cost_report token_type strings.
export function computeBlendedRate(usage, tokenCosts) {
  const inputSpend =
    (tokenCosts.get("uncached_input_tokens") ?? 0) +
    (tokenCosts.get("cache_creation.ephemeral_5m_input_tokens") ?? 0) +
    (tokenCosts.get("cache_creation.ephemeral_1h_input_tokens") ?? 0);
  const cachedSpend = tokenCosts.get("cache_read_input_tokens") ?? 0;
  const outputSpend = tokenCosts.get("output_tokens") ?? 0;

  return blendedRateFromBuckets([
    {
      type: "input",
      spend: inputSpend,
      tokens: usage.uncachedInputTokens + usage.cacheCreationTokens,
    },
    { type: "cached", spend: cachedSpend, tokens: usage.cacheReadInputTokens },
    { type: "output", spend: outputSpend, tokens: usage.outputTokens },
  ]);
}

// What the same token mix would have cost at official list prices, used to
// benchmark the actual blended rate above against. Models with no entry in
// the pricing table are skipped (reported via modelsSkipped) rather than
// poisoning the total with a missing/zero rate.
// usageByModel: Map<model, usage-shape> from aggregateUsageGrouped(buckets, "model").
// pricingLookupFn: e.g. modelPricingFor — returns {input, cached, output} USD/1M or null.
export function computeExpectedListRate(usageByModel, pricingLookupFn) {
  const totals = { input: [0, 0], cached: [0, 0], output: [0, 0] }; // [spend, tokens]
  let modelsSkipped = 0;

  for (const [model, usage] of usageByModel) {
    const pricing = pricingLookupFn(model);
    if (!pricing) {
      modelsSkipped += 1;
      continue;
    }
    const inputTokens = usage.uncachedInputTokens + usage.cacheCreationTokens;
    totals.input[0] += (inputTokens / 1_000_000) * pricing.input;
    totals.input[1] += inputTokens;
    totals.cached[0] += (usage.cacheReadInputTokens / 1_000_000) * pricing.cached;
    totals.cached[1] += usage.cacheReadInputTokens;
    totals.output[0] += (usage.outputTokens / 1_000_000) * pricing.output;
    totals.output[1] += usage.outputTokens;
  }

  return {
    ...blendedRateFromBuckets([
      { type: "input", spend: totals.input[0], tokens: totals.input[1] },
      { type: "cached", spend: totals.cached[0], tokens: totals.cached[1] },
      { type: "output", spend: totals.output[0], tokens: totals.output[1] },
    ]),
    modelsSkipped,
  };
}
