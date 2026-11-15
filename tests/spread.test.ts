/**
 * The browser spread model (src/spread/model.ts) against the fire repo's Python model, on the reference cases of
 * tools/compare_spread.py (ignition, observation-started and chained library forecasts, an operator-added fire):
 * - one run without perturbation: arrival times cell by cell, and IoU of the area reached by each horizon;
 * - the 40-run ensemble: IoU of the P >= 50 % area at 0.5 / 1 / 2 / 3 / 6 / 12 h (the draws differ, the
 *   distributions do not).
 *
 *   npx tsx tests/spread.test.ts
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { ensemble, prepareGrid, runMtt, weatherFrom, moistureBase, type SpreadModelFile } from '../src/spread/model';
import { cleanMask, fromUtm, outline, rasterize, smoothOutline, toUtm, SMOOTH_MIN_HOLE_CELLS } from '../src/spread/geo';
import type { Geometry } from 'geojson';

const dir = new URL('../public/scenarios/marmaris_2022/', import.meta.url);
const file = JSON.parse(readFileSync(new URL('spread_model.json', dir), 'utf8')) as SpreadModelFile;
const raw = gunzipSync(readFileSync(new URL('spread_grid.bin.gz', dir)));
const grid = prepareGrid(file, raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
const fx = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/spread_cases.json.gz', import.meta.url))).toString()) as {
  horizons_hours: number[]; cases: { label: string; issued_at: string; start: string; det_arrival: string; p50: Record<string, string>; p50_other_seed: Record<string, string>; p50_400?: Record<string, string> }[] };
const n = grid.width * grid.height;
const unbits = (b64: string) => { const b = Buffer.from(b64, 'base64'); const out = new Uint8Array(n); for (let i = 0; i < n; i++) out[i] = (b[i >> 3] >> (i & 7)) & 1; return out; };
const iou = (a: (i: number) => boolean, b: (i: number) => boolean) => {
  let inter = 0, uni = 0;
  for (let i = 0; i < n; i++) { const x = a(i), y = b(i); if (x && y) inter++; if (x || y) uni++; }
  return uni ? inter / uni : 1;
};
let failures = 0;
let casesAt90 = 0;
const fail = (m: string) => { failures++; console.log('FAIL', m); };
const rows: string[] = [];
const head = ['case', 'single run: max |Δt| (min)', 'single run IoU (min over h)', ...fx.horizons_hours.map((h) => `MC IoU ${h < 1 ? '30 min' : `${h} h`}`),
  'seed vs seed 6 / 12 h: Python, browser', '400 runs IoU 6 / 12 h', 'browser MC (s)'];
const key = (h: number) => (Number.isInteger(h) ? `${h}.0` : String(h));
rows.push(`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`);
for (const c of fx.cases) {
  const start = unbits(c.start);
  const t0 = Date.parse(c.issued_at);
  // One run without perturbation.
  const w = weatherFrom(file, t0, 13);
  const wdr = Array.from(w.wd, (x) => (x * Math.PI) / 180);
  const det = runMtt({ grid, ignition: start, ws: w.ws, wsin: Float32Array.from(wdr, Math.sin), wcos: Float32Array.from(wdr, Math.cos), mm: w.mm,
    mBase: moistureBase(grid, w.refRh, w.refTc), maxTimeMin: 720, maxLb: file.settings.max_lb_ratio, r0Mult: 1 });
  const py = new Float32Array(Buffer.from(c.det_arrival, 'base64').buffer.slice(0));
  let maxD = 0;
  for (let i = 0; i < n; i++) if (Number.isFinite(det[i]) && Number.isFinite(py[i])) maxD = Math.max(maxD, Math.abs(det[i] - py[i]));
  const detIou = Math.min(...fx.horizons_hours.map((h) => iou((i) => det[i] <= h * 60, (i) => py[i] <= h * 60)));
  // The ensemble.
  const t = performance.now();
  const p50 = (await ensemble({ grid, ignition: start, t0, maxHours: 12, runs: file.settings.mc_runs, seed: file.settings.seed }))!;
  const sec = (performance.now() - t) / 1000;
  const mcIou = fx.horizons_hours.map((h) => { const m = unbits(c.p50[Number.isInteger(h) ? `${h}.0` : String(h)]); return iou((i) => p50[i] <= h * 60, (i) => m[i] === 1); });
  // Sampling noise: each ensemble against itself with another seed (40 runs of a small fire differ a lot).
  const noise = fx.horizons_hours.map((h) => { const a = unbits(c.p50[key(h)]), b = unbits(c.p50_other_seed[key(h)]); return iou((i) => a[i] === 1, (i) => b[i] === 1); });
  const other = (await ensemble({ grid, ignition: start, t0, maxHours: 12, runs: file.settings.mc_runs, seed: file.settings.seed + 1 }))!;
  const jsNoise = fx.horizons_hours.map((h) => iou((i) => p50[i] <= h * 60, (i) => other[i] <= h * 60));
  // With 400 runs (two cases): the two models must converge.
  let big = '–';
  if (c.p50_400) {
    const b400 = (await ensemble({ grid, ignition: start, t0, maxHours: 12, runs: 400, seed: 7 }))!;
    const v = [6, 12].map((h) => { const m = unbits(c.p50_400![`${h}.0`]); return iou((i) => b400[i] <= h * 60, (i) => m[i] === 1); });
    big = v.map((x) => x.toFixed(3)).join(' / ');
    v.forEach((x, k) => { if (x < 0.9) fail(`${c.label}: 400-run ensembles IoU ${x.toFixed(3)} at ${[6, 12][k]} h < 0.9`); });
  }
  rows.push(`| ${c.label} | ${maxD.toFixed(3)} | ${detIou.toFixed(4)} | ${mcIou.map((x) => x.toFixed(3)).join(' | ')} | `
    + `${noise[4].toFixed(2)} / ${noise[5].toFixed(2)}, ${jsNoise[4].toFixed(2)} / ${jsNoise[5].toFixed(2)} | ${big} | ${sec.toFixed(2)} |`);
  if (detIou < 0.99) fail(`${c.label}: single run IoU ${detIou.toFixed(4)} < 0.99`);
  // An ensemble must agree to IoU 0.9, or as well as an ensemble agrees with itself under another seed (minus 0.05).
  mcIou.forEach((x, k) => { const nz = Math.min(noise[k], jsNoise[k]); if (x < Math.min(0.9, nz - 0.05)) fail(`${c.label}: ensemble IoU ${x.toFixed(3)} at ${fx.horizons_hours[k]} h (seed vs seed ${nz.toFixed(3)})`); });
  if (mcIou.every((x) => x >= 0.9)) casesAt90++;
}
console.log(rows.join('\n'));

// Geometry: UTM round trip; outline -> rasterize round trip; the library's starting area rasterized vs Python's mask.
const gg = { width: grid.width, height: grid.height, transform: file.grid.transform, zone: file.grid.utm_zone };
let utmErr = 0;
for (const [lon, lat] of [[28.0, 36.8], [28.2, 36.9], [28.35, 36.75]]) { const [x, y] = toUtm(lon, lat, 35); const [lo, la] = fromUtm(x, y, 35); utmErr = Math.max(utmErr, Math.hypot((lo - lon) * 89000, (la - lat) * 111000)); }
if (utmErr > 0.05) fail(`UTM round trip error ${utmErr.toFixed(3)} m`);
const lib = JSON.parse(readFileSync(new URL('forecast_library.json', dir), 'utf8')) as { forecasts: { issued_at: string; contours: { horizon_hours: number; geometry: Geometry }[] }[] };
const geoRows: string[] = [];
for (const c of fx.cases.filter((x) => /observation/.test(x.label))) {
  const mask = unbits(c.start);
  const trip = rasterize(gg, [outline(gg, (i) => mask[i] === 1, 0)!], undefined, false);
  const tripIou = iou((i) => trip[i] === 1, (i) => mask[i] === 1);
  const f = lib.forecasts.find((x) => Math.abs(Date.parse(x.issued_at) - Date.parse(c.issued_at)) < 60000);
  const libStart = f && rasterize(gg, [f.contours.find((k) => k.horizon_hours === 0)!.geometry], undefined, false);
  const libIou = libStart ? iou((i) => libStart[i] === 1, (i) => mask[i] === 1) : NaN;
  geoRows.push(`${c.label}: outline round trip IoU ${tripIou.toFixed(4)}; library start contour rasterized vs Python mask IoU ${libIou.toFixed(3)}`);
  if (tripIou < 0.999) fail(`${c.label}: outline round trip IoU ${tripIou.toFixed(4)}`);
  if (!(libIou >= 0.9)) fail(`${c.label}: rasterized start contour IoU ${libIou.toFixed(3)}`);
}

// The smoothed outline drawn for a browser forecast: no crossing or touching edges, no small holes, close to the
// cells it was made from, and to the Python-smoothed library contours.
type Ring = number[][];
const ringsOf = (g: Geometry | null): Ring[] => (!g ? [] : g.type === 'Polygon' ? g.coordinates : g.type === 'MultiPolygon' ? g.coordinates.flat() : []);
function crossings(rings: Ring[]): number {
  // Every pair of non-adjacent segments, bucketed on a coarse grid.
  const segs: [number, number, number, number, number, number][] = [];
  rings.forEach((r, ri) => { for (let i = 1; i < r.length; i++) segs.push([r[i - 1][0], r[i - 1][1], r[i][0], r[i][1], ri, i]); });
  const cell = 0.002, buckets = new Map<string, number[]>();
  segs.forEach((sg, k) => {
    for (let x = Math.floor(Math.min(sg[0], sg[2]) / cell); x <= Math.floor(Math.max(sg[0], sg[2]) / cell); x++)
      for (let y = Math.floor(Math.min(sg[1], sg[3]) / cell); y <= Math.floor(Math.max(sg[1], sg[3]) / cell); y++) {
        const b = `${x},${y}`; (buckets.get(b) ?? buckets.set(b, []).get(b)!).push(k);
      }
  });
  const orient = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
  let n = 0; const done = new Set<string>();
  for (const list of buckets.values()) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const [a, b] = [segs[list[i]], segs[list[j]]];
    const id = `${list[i]},${list[j]}`; if (done.has(id)) continue; done.add(id);
    if (a[4] === b[4]) { const len = rings[a[4]].length - 1; const d = Math.abs(a[5] - b[5]); if (d <= 1 || d === len - 1) continue; }
    const o1 = orient(a[0], a[1], a[2], a[3], b[0], b[1]), o2 = orient(a[0], a[1], a[2], a[3], b[2], b[3]);
    const o3 = orient(b[0], b[1], b[2], b[3], a[0], a[1]), o4 = orient(b[0], b[1], b[2], b[3], a[2], a[3]);
    if (o1 !== o2 && o3 !== o4) n++;
  }
  return n;
}
const holeCells = (g: Geometry | null) => {
  let small = 0;
  for (const poly of g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [])
    for (const h of poly.slice(1)) { const m = rasterize(gg, [{ type: 'Polygon', coordinates: [h] }], undefined, false); let k = 0; for (const x of m) k += x; if (k < SMOOTH_MIN_HOLE_CELLS / 2) small++; }
  return small;
};
let smoothChecked = 0, worstCleanIou = 1, worstRawIou = 1, worstLibIou = 1, maxCross = 0, smallHoles = 0;
for (const c of fx.cases) {
  for (const [label, mask] of [['start', unbits(c.start)], ...fx.horizons_hours.map((h) => [`P50 ${h} h`, unbits(c.p50[key(h)])] as const)] as [string, Uint8Array][]) {
    const g = smoothOutline(gg, (i) => mask[i] === 1);
    const clean = cleanMask(gg.width, gg.height, (i) => mask[i] === 1);
    const back = rasterize(gg, [g!], undefined, false);
    const ci = iou((i) => back[i] === 1, (i) => clean[i] === 1), ri = iou((i) => back[i] === 1, (i) => mask[i] === 1);
    const x = crossings(ringsOf(g));
    worstCleanIou = Math.min(worstCleanIou, ci); worstRawIou = Math.min(worstRawIou, ri); maxCross = Math.max(maxCross, x);
    smallHoles += holeCells(g);
    if (x) fail(`${c.label} ${label}: smoothed outline has ${x} crossing segments`);
    if (ci < 0.95) fail(`${c.label} ${label}: smoothed outline vs cleaned cells IoU ${ci.toFixed(3)}`);
    if (ri < 0.9) fail(`${c.label} ${label}: smoothed outline vs cells IoU ${ri.toFixed(3)}`);
    smoothChecked++;
  }
  // The same smoothing as the library (Python buffer/simplify) on the same start: the two outlines agree.
  const f = lib.forecasts.find((x) => Math.abs(Date.parse(x.issued_at) - Date.parse(c.issued_at)) < 60000);
  if (f) {
    const mask = unbits(c.start);
    const a = rasterize(gg, [smoothOutline(gg, (i) => mask[i] === 1)!], undefined, false);
    const b = rasterize(gg, [f.contours.find((k) => k.horizon_hours === 0)!.geometry], undefined, false);
    worstLibIou = Math.min(worstLibIou, iou((i) => a[i] === 1, (i) => b[i] === 1));
  }
}
if (smallHoles) fail(`${smallHoles} holes under ${SMOOTH_MIN_HOLE_CELLS / 2} cells left in smoothed outlines`);
if (worstLibIou < 0.9) fail(`smoothed start vs the library's smoothed start: IoU ${worstLibIou.toFixed(3)}`);
// Small things: one burning cell keeps an outline; a one-cell hole is filled; a tiny far part is dropped unless kept.
{
  const W = gg.width, H = gg.height, at = (c: number, r: number) => r * W + c;
  const one = new Uint8Array(W * H); one[at(80, 80)] = 1;
  if (!smoothOutline(gg, (i) => one[i] === 1)) fail('a single burning cell lost its outline');
  const ring = new Uint8Array(W * H);
  for (let r = 40; r < 50; r++) for (let c = 40; c < 50; c++) ring[at(c, r)] = 1;
  ring[at(45, 45)] = 0; ring[at(100, 100)] = 1;
  const g = smoothOutline(gg, (i) => ring[i] === 1)!;
  if (g.type !== 'Polygon' || g.coordinates.length !== 1) fail(`one-cell hole and one-cell far part should be gone: ${g.type} ${JSON.stringify(g.coordinates.map((p) => p.length))}`);
  const keep = new Uint8Array(W * H); keep[at(100, 100)] = 1;
  if (smoothOutline(gg, (i) => ring[i] === 1, keep)?.type !== 'MultiPolygon') fail('a kept far part (an operator-confirmed fire) was dropped');
}
console.log(`smoothed outlines: ${smoothChecked} masks; IoU vs cleaned cells >= ${worstCleanIou.toFixed(3)}, vs raw cells >= ${worstRawIou.toFixed(3)}; `
  + `start vs library (Python-smoothed) >= ${worstLibIou.toFixed(3)}; crossing segments ${maxCross}`);

console.log(`UTM round trip ${(utmErr * 1000).toFixed(2)} mm\n${geoRows.join('\n')}`);
if (casesAt90 < 5) fail(`only ${casesAt90} cases with ensemble IoU >= 0.9 at every horizon (at least 5 required)`);
console.log(`spread: ${fx.cases.length} cases against the Python model, ${casesAt90} with ensemble IoU >= 0.9 at every horizon; ${failures} failures`);
process.exit(failures ? 1 : 0);
