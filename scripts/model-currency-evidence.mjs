// DISTINCT-FROM: scripts/refresh-model-catalog.mjs — independent effort-specific evaluation evidence, never router authority.
import { createHash } from 'node:crypto';

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Captured AA Next Flight contract. No eval/script execution; a changed schema fails closed. */
export function parseArtificialAnalysis(html, { url, checkedAt, identityBindings = {} } = {}) {
  const version = html.match(/Artificial Analysis Intelligence Index v(\d+\.\d+(?:\.\d+)?)/)?.[1];
  if (!version) throw new Error('AA Intelligence Index version is absent');
  const rows = new Map();
  const walk = (value) => {
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value.intelligenceIndexEvaluations) && typeof value.id === 'string') {
      rows.set(value.id, value); return;
    }
    for (const child of Object.values(value)) walk(child);
  };
  for (const match of html.matchAll(/self\.__next_f\.push\((.*?)\)<\/script>/gs)) {
    try {
      const envelope = JSON.parse(match[1]);
      if (typeof envelope[1] !== 'string' || !envelope[1].includes('intelligenceIndexEvaluations')) continue;
      const line = envelope[1];
      walk(JSON.parse(line.slice(line.indexOf(':') + 1)));
    } catch { /* unrelated or chunked flight frame; required rows checked below */ }
  }
  const source = { url, checkedAt, sha256: digest(html), parser: 'aa-next-flight-v1' };
  const records = [];
  for (const row of rows.values()) {
    const effortLabel = typeof row.suffix === 'string' ? row.suffix : row.name?.match(/\((Low|Medium|High|Xhigh|Max|Minimal|None)(?:,|\))/i)?.[1];
    const effort = effortLabel?.split(',')[0]?.trim().toLowerCase();
    if (!['low', 'medium', 'high', 'xhigh', 'max', 'minimal', 'none'].includes(effort)) continue;
    if (!row.release?.slug || !finite(row.intelligenceIndex) || row.intelligenceIndexIsEstimated !== false) continue;
    const benchmarks = row.intelligenceIndexEvaluations.filter((b) => typeof b.slug === 'string'
      && Number.isFinite(b.score) && finite(b.costPerTask) && finite(b.timePerTask))
      .map((b) => ({ suite: b.slug, score: b.score, costUsd: b.costPerTask, timeSeconds: b.timePerTask }));
    const binding = identityBindings[row.release.slug];
    if (binding && (typeof binding.model !== 'string' || !binding.evidence || !binding.checkedAt)) {
      throw new Error(`Invalid native identity binding: ${row.release.slug}`);
    }
    records.push({
      sourceModelId: row.id, sourceReleaseSlug: row.release.slug, sourceName: row.name,
      model: binding?.model ?? null, identityEvidence: binding ?? null, effort,
      benchmark: { suite: 'artificial-analysis-intelligence-index', version },
      quality: { intelligenceIndex: row.intelligenceIndex, estimated: false }, benchmarks,
      costPerTaskUsd: finite(row.intelligenceIndexCostPerTask?.cost?.total) ? row.intelligenceIndexCostPerTask.cost.total : null,
      timePerTaskSeconds: finite(row.intelligenceIndexTimePerTask) ? row.intelligenceIndexTimePerTask : null,
      speedTokensPerSecond: finite(row.outputSpeedVariance?.median ?? row.medianOutputSpeed) ? (row.outputSpeedVariance?.median ?? row.medianOutputSpeed) : null,
      inputUsdPerMillion: finite(row.price1mInputTokens) ? row.price1mInputTokens : null,
      outputUsdPerMillion: finite(row.price1mOutputTokens) ? row.price1mOutputTokens : null,
      source,
    });
  }
  if (records.length === 0 || !records.some((r) => r.benchmarks.length > 0 && r.costPerTaskUsd !== null && r.timePerTaskSeconds !== null)) {
    throw new Error('AA effort benchmark matrix absent or incomplete');
  }
  return { source, records };
}

export function parseInventory(body, source) {
  const data = JSON.parse(body).data;
  if (!Array.isArray(data) || data.length < 50) throw new Error('OpenRouter inventory is suspiciously thin');
  const models = data.map((row) => {
    const input = Number(row.pricing?.prompt); const output = Number(row.pricing?.completion);
    if (typeof row.id !== 'string' || !row.id || !Number.isFinite(input) || !Number.isFinite(output)) throw new Error('Invalid OpenRouter model/pricing');
    return { id: row.id, pricing: { inputUsdPerMillion: finite(input) ? input * 1e6 : null, outputUsdPerMillion: finite(output) ? output * 1e6 : null },
      supportedParameters: Array.isArray(row.supported_parameters) ? row.supported_parameters.filter((p) => typeof p === 'string') : [] };
  });
  return { checkedAt: source.checkedAt, source, models, discoveryOnly: true };
}

/** No benchmark row can certify native access, supported effort, or default-selection eligibility. */
export function currencyStatus(record, now = Date.now()) {
  const fresh = (section) => {
    const checked = Date.parse(section?.checkedAt);
    return Number.isFinite(checked) && checked <= now && now - checked < WEEK_MS;
  };
  const inventoryFresh = record?.schemaVersion === 1 && fresh(record.inventory)
    && record.inventory.discoveryOnly === true && record.inventory.models?.length >= 50;
  const evaluationsFresh = record?.schemaVersion === 1 && fresh(record.evaluations)
    && record.evaluations.sources?.length > 0 && record.evaluations.records?.length > 0
    && record.evaluations.sources.every((source) => fresh(source) && /^[a-f0-9]{64}$/.test(source.sha256 ?? ''));
  const failed = !!record?.lastAttempt && record.lastAttempt.status !== 'complete';
  return { status: inventoryFresh && evaluationsFresh && !failed ? 'current' : 'stale', inventoryFresh: !!inventoryFresh,
    evaluationsFresh: !!evaluationsFresh, selectionQualified: false, maxAgeMs: WEEK_MS,
    errors: record?.lastAttempt?.errors ?? [], assessment: record?.assessment ?? null, reason: failed ? 'last refresh incomplete' : inventoryFresh && evaluationsFresh ? 'fresh independent evidence' : 'weekly evidence required' };
}
