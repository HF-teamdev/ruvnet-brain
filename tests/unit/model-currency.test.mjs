import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArtificialAnalysis, currencyStatus, WEEK_MS } from '../../scripts/model-currency-evidence.mjs';
import { refreshModelCurrency, maybeLaunchCurrencyRefresh, readCurrencyStatus } from '../../scripts/model-currency.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('../fixtures/model-currency/aa-captured-rows.json', import.meta.url)));
const makeHtml = (rows) => `<p>Artificial Analysis Intelligence Index v${fixture.indexVersion}</p><script>self.__next_f.push(${JSON.stringify([1, `28:${JSON.stringify({ rows })}`])})</script>`;
const html = makeHtml(fixture.rows);
const NOW = Date.parse('2026-10-04T15:00:00Z');
const source = { url: fixture.sourceUrl, checkedAt: new Date(NOW).toISOString() };
const bindings = { 'gpt-6-1-sol': { model: 'gpt-6.1-sol', evidence: 'native launch receipt', checkedAt: source.checkedAt } };
const dirs = [];
const dir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-currency-test-')); dirs.push(d); return d; };
const inventory = JSON.stringify({ data: Array.from({ length: 50 }, (_, i) => ({ id: `provider/model-${i}`, pricing: { prompt: '0.000001', completion: '0.000002' }, supported_parameters: ['reasoning'] })) });
const goodFetch = async (url) => ({ ok: true, text: async () => url.includes('openrouter') ? inventory : html });
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('independent currency evidence', () => {
  it('parses captured measured effort rows without making unbound identities eligible', () => {
    const result = parseArtificialAnalysis(html, { ...source, identityBindings: bindings });
    expect(result.records).toHaveLength(2);
    expect(result.records.map((r) => r.effort)).toEqual(['max', 'high']);
    expect(result.records[0].model).toBe('gpt-6.1-sol');
    expect(result.records[0].benchmark.version).toBe('4.3.2');
    expect(result.records[0].benchmarks.find((b) => b.suite === 'terminalbench-4-0').timeSeconds).toBeGreaterThan(0);
    expect(parseArtificialAnalysis(html, source).records.every((r) => r.model === null)).toBe(true);
  });
  it('fails changed HTML, estimated-only scores, and invalid identity evidence', () => {
    expect(() => parseArtificialAnalysis('<html>200 OK</html>', source)).toThrow(/version/);
    expect(() => parseArtificialAnalysis(html.replaceAll('intelligenceIndexEvaluations', 'unknown'), source)).toThrow(/matrix/);
    expect(() => parseArtificialAnalysis(makeHtml(fixture.rows.map((r) => ({ ...r, intelligenceIndexIsEstimated: true }))), source)).toThrow(/matrix/);
    expect(() => parseArtificialAnalysis(html, { ...source, identityBindings: { 'gpt-6-1-sol': { model: 'fake' } } })).toThrow(/identity binding/);
  });
  it('collects all sources, stores bytes, stamps weekly evidence, and never certifies selection', async () => {
    const routerDir = dir();
    const result = await refreshModelCurrency({ routerDir, now: NOW, fetchImpl: goodFetch, identityBindings: bindings, aaUrls: [source.url] });
    expect(result.status).toBe('current');
    expect(result.selectionQualified).toBe(false);
    expect(fs.readdirSync(path.join(routerDir, 'evidence'))).toHaveLength(2);
    expect(readCurrencyStatus({ routerDir, now: NOW + WEEK_MS }).status).toBe('stale');
    expect(readCurrencyStatus({ routerDir, now: NOW - 1 }).status).toBe('stale');
  });
  it('failed refresh keeps all prior verified records/timestamps and records explicit stale failure', async () => {
    const routerDir = dir();
    await refreshModelCurrency({ routerDir, now: NOW, fetchImpl: goodFetch, aaUrls: [source.url] });
    const before = JSON.parse(fs.readFileSync(path.join(routerDir, 'currency.json')));
    const result = await refreshModelCurrency({ routerDir, now: NOW + 1, fetchImpl: async () => { throw new Error('network down'); }, aaUrls: [source.url] });
    const after = JSON.parse(fs.readFileSync(path.join(routerDir, 'currency.json')));
    expect(after.inventory).toEqual(before.inventory); expect(after.evaluations).toEqual(before.evaluations);
    expect(result.status).toBe('stale'); expect(result.lastAttempt.status).toBe('failed');
  });
  it('partial page refresh cannot certify an incomplete effort matrix as fresh', async () => {
    const routerDir = dir();
    await refreshModelCurrency({ routerDir, now: NOW, fetchImpl: goodFetch, aaUrls: [source.url] });
    const before = JSON.parse(fs.readFileSync(path.join(routerDir, 'currency.json')));
    const result = await refreshModelCurrency({ routerDir, now: NOW + 1, fetchImpl: async (url) => url.endsWith('/broken') ? { ok: true, text: async () => '<html>not benchmarks</html>' } : goodFetch(url), aaUrls: [source.url, 'https://artificialanalysis.ai/broken'] });
    const after = JSON.parse(fs.readFileSync(path.join(routerDir, 'currency.json')));
    expect(after.evaluations).toEqual(before.evaluations);
    expect(result.status).toBe('stale'); expect(result.lastAttempt.status).toBe('partial');
  });
  it('prompt path deduplicates concurrent catchup and never calls network', () => {
    const routerDir = dir(); let launched = 0;
    const launch = () => { launched++; return { once() {}, unref() {} }; };
    expect(maybeLaunchCurrencyRefresh({ routerDir, now: NOW, launch }).launched).toBe(true);
    expect(maybeLaunchCurrencyRefresh({ routerDir, now: NOW, launch }).deferred).toBe('refresh already running');
    expect(launched).toBe(1);
    expect(currencyStatus(null, NOW).status).toBe('stale');
  });
  it('failed refresh cooldown avoids a request on every prompt', async () => {
    const routerDir = dir();
    await refreshModelCurrency({ routerDir, now: NOW, fetchImpl: async () => { throw new Error('down'); }, aaUrls: [] });
    expect(maybeLaunchCurrencyRefresh({ routerDir, now: NOW + 1000, launch: () => { throw new Error('must not launch'); } }).deferred).toBe('retry cooldown');
  });
});
