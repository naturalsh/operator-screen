/**
 * Geometry between the map (WGS84 longitude / latitude) and the model grid (UTM, north-up, 60 m cells):
 * UTM projection, polygon rasterisation (every touched cell, as rasterio's all_touched) and the outline of a cell
 * mask as GeoJSON polygons (with holes), simplified to about 30 m like the precomputed contours.
 */
import type { Geometry, MultiPolygon, Polygon } from 'geojson';

const A = 6378137, F = 1 / 298.257223563, K0 = 0.9996, E2 = F * (2 - F), EP2 = E2 / (1 - E2);
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** WGS84 longitude / latitude to UTM easting / northing (northern hemisphere). */
export function toUtm(lon: number, lat: number, zone: number): [number, number] {
  const phi = rad(lat), lam = rad(lon) - rad((zone - 1) * 6 - 180 + 3);
  const N = A / Math.sqrt(1 - E2 * Math.sin(phi) ** 2);
  const T = Math.tan(phi) ** 2, C = EP2 * Math.cos(phi) ** 2, Aa = Math.cos(phi) * lam;
  const M = A * ((1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256) * phi - ((3 * E2) / 8 + (3 * E2 ** 2) / 32 + (45 * E2 ** 3) / 1024) * Math.sin(2 * phi)
    + ((15 * E2 ** 2) / 256 + (45 * E2 ** 3) / 1024) * Math.sin(4 * phi) - ((35 * E2 ** 3) / 3072) * Math.sin(6 * phi));
  const x = K0 * N * (Aa + ((1 - T + C) * Aa ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * EP2) * Aa ** 5) / 120) + 500000;
  const y = K0 * (M + N * Math.tan(phi) * (Aa * Aa / 2 + ((5 - T + 9 * C + 4 * C * C) * Aa ** 4) / 24
    + ((61 - 58 * T + T * T + 600 * C - 330 * EP2) * Aa ** 6) / 720));
  return [x, y];
}

/** UTM easting / northing (northern hemisphere) to WGS84 longitude / latitude. */
export function fromUtm(x: number, y: number, zone: number): [number, number] {
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const M = y / K0;
  const mu = M / (A * (1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256));
  const p1 = mu + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) + ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu)
    + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) + ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const N1 = A / Math.sqrt(1 - E2 * Math.sin(p1) ** 2), T1 = Math.tan(p1) ** 2, C1 = EP2 * Math.cos(p1) ** 2;
  const R1 = (A * (1 - E2)) / (1 - E2 * Math.sin(p1) ** 2) ** 1.5, D = (x - 500000) / (N1 * K0);
  const lat = p1 - ((N1 * Math.tan(p1)) / R1) * (D * D / 2 - ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D ** 4) / 24
    + ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * D ** 6) / 720);
  const lon = (D - ((1 + 2 * T1 + C1) * D ** 3) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * D ** 5) / 120) / Math.cos(p1);
  return [deg(lon) + (zone - 1) * 6 - 180 + 3, deg(lat)];
}

/** The model grid: affine transform [a, b, c, d, e, f] (x = a*col + c, y = e*row + f, north-up). */
export interface GridGeo { width: number; height: number; transform: number[]; zone: number }

/** Longitude / latitude to fractional (column, row). */
export function toCell(g: GridGeo, lon: number, lat: number): [number, number] {
  const [x, y] = toUtm(lon, lat, g.zone);
  const [a, , c, , e, f] = g.transform;
  return [(x - c) / a, (y - f) / e];
}

/** Fractional (column, row) to longitude / latitude. */
export function fromCell(g: GridGeo, col: number, row: number): [number, number] {
  const [a, , c, , e, f] = g.transform;
  return fromUtm(a * col + c, e * row + f, g.zone);
}

const polygonsOf = (geom: Geometry): number[][][][] => (geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : []);

/**
 * Marks the cells of polygons. `allTouched` (default, like rasterio's all_touched, used by the Python model for
 * observations and drawn areas): every cell the outline crosses, plus those with the centre inside. Without it:
 * centres inside only, for areas that are already a model raster (the estimated fire), which would otherwise grow
 * by one cell at every round trip.
 */
export function rasterize(g: GridGeo, geoms: Geometry[], into?: Uint8Array, allTouched = true): Uint8Array {
  const out = into ?? new Uint8Array(g.width * g.height);
  const set = (c: number, r: number) => { if (c >= 0 && r >= 0 && c < g.width && r < g.height) out[r * g.width + c] = 1; };
  for (const geom of geoms) {
    for (const poly of polygonsOf(geom)) {
      const rings = poly.map((ring) => ring.map(([lon, lat]) => toCell(g, lon, lat)));
      // Outline: every cell a segment passes through (a fine walk along the segment).
      if (allTouched) for (const ring of rings) {
        for (let i = 1; i < ring.length; i++) {
          const [x0, y0] = ring[i - 1], [x1, y1] = ring[i];
          const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 4));
          for (let s = 0; s <= steps; s++) set(Math.floor(x0 + ((x1 - x0) * s) / steps), Math.floor(y0 + ((y1 - y0) * s) / steps));
        }
      }
      // Interior: cell centres inside (even-odd over all rings: holes excluded).
      const ys = rings.flat().map((p) => p[1]);
      const r0 = Math.max(0, Math.floor(Math.min(...ys))), r1 = Math.min(g.height - 1, Math.ceil(Math.max(...ys)));
      for (let r = r0; r <= r1; r++) {
        const cy = r + 0.5;
        const xs: number[] = [];
        for (const ring of rings) for (let i = 1; i < ring.length; i++) {
          const [xa, ya] = ring[i - 1], [xb, yb] = ring[i];
          if ((ya > cy) !== (yb > cy)) xs.push(xa + ((cy - ya) * (xb - xa)) / (yb - ya));
        }
        xs.sort((p, q) => p - q);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          for (let c = Math.max(0, Math.ceil(xs[k] - 0.5)); c <= Math.min(g.width - 1, Math.floor(xs[k + 1] - 0.5)); c++) set(c, r);
        }
      }
    }
  }
  return out;
}

/** Douglas-Peucker on a closed ring in cell units. */
function simplify(ring: [number, number][], tol: number): [number, number][] {
  if (ring.length <= 5) return ring;
  const keep = new Uint8Array(ring.length); keep[0] = keep[ring.length - 1] = 1;
  // Split at the farthest point from the first, so a closed ring keeps its shape.
  let far = 1, best = -1;
  for (let i = 1; i < ring.length - 1; i++) { const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]); if (d > best) { best = d; far = i; } }
  keep[far] = 1;
  const stack: [number, number][] = [[0, far], [far, ring.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop()!;
    const [ax, ay] = ring[i0], [bx, by] = ring[i1];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1;
    let m = -1, md = tol;
    for (let i = i0 + 1; i < i1; i++) { const d = Math.abs((ring[i][0] - ax) * dy - (ring[i][1] - ay) * dx) / L; if (d > md) { md = d; m = i; } }
    if (m >= 0) { keep[m] = 1; stack.push([i0, m], [m, i1]); }
  }
  const out = ring.filter((_, i) => keep[i]);
  return out.length >= 4 ? out : ring;
}

const ringArea = (r: [number, number][]) => r.reduce((s, p, i) => (i ? s + (r[i - 1][0] * p[1] - p[0] * r[i - 1][1]) : s), 0) / 2;
function inside(pt: [number, number], ring: [number, number][]): boolean {
  let ins = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}

/**
 * Outline of the cells where `on(i)` holds, as a (Multi)Polygon in longitude / latitude: the cell edges between
 * marked and unmarked cells, linked into rings (holes kept), simplified by `tolCells` (0.5 = 30 m at 60 m cells).
 */
export function outline(g: GridGeo, on: (i: number) => boolean, tolCells = 0.5): Polygon | MultiPolygon | null {
  const W = g.width, H = g.height;
  const inCell = (c: number, r: number) => c >= 0 && r >= 0 && c < W && r < H && on(r * W + c);
  // Directed boundary edges with the marked cell on the left (vertex = corner index r*(W+1)+c).
  const next = new Map<number, number[]>();
  const add = (a: number, b: number) => { const l = next.get(a); if (l) l.push(b); else next.set(a, [b]); };
  const V = (c: number, r: number) => r * (W + 1) + c;
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    if (!inCell(c, r)) continue;
    if (!inCell(c, r - 1)) add(V(c + 1, r), V(c, r));        // top edge, right to left
    if (!inCell(c - 1, r)) add(V(c, r), V(c, r + 1));        // left edge, down
    if (!inCell(c, r + 1)) add(V(c, r + 1), V(c + 1, r + 1)); // bottom edge, left to right
    if (!inCell(c + 1, r)) add(V(c + 1, r + 1), V(c + 1, r)); // right edge, up
  }
  if (!next.size) return null;
  const xy = (v: number): [number, number] => [v % (W + 1), Math.floor(v / (W + 1))];
  const rings: [number, number][][] = [];
  while (next.size) {
    const [startV, outs] = next.entries().next().value as [number, number[]];
    let v = startV, prev = -1;
    const ring: [number, number][] = [];
    let cur = outs[0];
    for (let guard = 0; guard < 4 * W * H + 8; guard++) {
      const list = next.get(v)!;
      // At a corner shared by two diagonal cells take the sharpest left turn, so rings never cross.
      let pick = 0;
      if (list.length > 1 && prev >= 0) {
        const [px, py] = xy(prev), [vx, vy] = xy(v);
        const din = [vx - px, vy - py];
        let bestTurn = Infinity;
        list.forEach((w, k) => { const [wx, wy] = xy(w); const cross = din[0] * (wy - vy) - din[1] * (wx - vx); const turn = cross < 0 ? 0 : cross === 0 ? 1 : 2; if (turn < bestTurn) { bestTurn = turn; pick = k; } });
      }
      cur = list.splice(pick, 1)[0];
      if (!list.length) next.delete(v);
      ring.push(xy(v));
      prev = v; v = cur;
      if (v === startV && !next.get(v)?.length) break;
      if (v === startV && ring.length > 2) break;
    }
    ring.push(ring[0]);
    if (ring.length >= 4) rings.push(simplify(ring, tolCells));
  }
  // Outer rings and holes by orientation (grid rows run south, so the sign flips); holes go to their outer ring.
  const outers = rings.filter((r) => ringArea(r) < 0), holes = rings.filter((r) => ringArea(r) > 0);
  const polys = outers.map((o) => [o]);
  for (const h of holes) { const host = polys.find((p) => inside(h[0], p[0])); if (host) host.push(h); }
  const toLL = (r: [number, number][]) => r.map(([c, rr]) => { const [lon, lat] = fromCell(g, c, rr); return [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5]; });
  const coords = polys.map((p) => p.map(toLL));
  if (!coords.length) return null;
  return coords.length === 1 ? { type: 'Polygon', coordinates: coords[0] } : { type: 'MultiPolygon', coordinates: coords };
}

/** What `smoothOutline` drops: holes and separate parts smaller than this many cells (60 m cells: 0.0036 km² each). */
export const SMOOTH_MIN_HOLE_CELLS = 12;
export const SMOOTH_MIN_PART_CELLS = 3;

/** Labels the 4-connected components of `want(i)` cells; returns the component id per cell (-1: not wanted) and sizes. */
function components(W: number, H: number, want: (i: number) => boolean): { id: Int32Array; size: number[]; touchesBorder: boolean[] } {
  const id = new Int32Array(W * H).fill(-1);
  const size: number[] = [], touchesBorder: boolean[] = [];
  const stack: number[] = [];
  for (let s = 0; s < W * H; s++) {
    if (id[s] >= 0 || !want(s)) continue;
    const k = size.length; size.push(0); touchesBorder.push(false);
    id[s] = k; stack.push(s);
    while (stack.length) {
      const i = stack.pop()!, c = i % W, r = (i - c) / W;
      size[k]++;
      if (c === 0 || r === 0 || c === W - 1 || r === H - 1) touchesBorder[k] = true;
      if (c > 0 && id[i - 1] < 0 && want(i - 1)) { id[i - 1] = k; stack.push(i - 1); }
      if (c < W - 1 && id[i + 1] < 0 && want(i + 1)) { id[i + 1] = k; stack.push(i + 1); }
      if (r > 0 && id[i - W] < 0 && want(i - W)) { id[i - W] = k; stack.push(i - W); }
      if (r < H - 1 && id[i + W] < 0 && want(i + W)) { id[i + W] = k; stack.push(i + W); }
    }
  }
  return { id, size, touchesBorder };
}

/**
 * The cell mask cleaned the way the precomputed contours are (shapely buffer(+60 m).buffer(-60 m)): a one-cell
 * closing (fills one-cell notches and gaps), holes under SMOOTH_MIN_HOLE_CELLS filled, separate parts under
 * SMOOTH_MIN_PART_CELLS dropped unless they hold a `keep` cell (an operator-confirmed fire is never dropped).
 */
export function cleanMask(W: number, H: number, on: (i: number) => boolean, keep?: Uint8Array): Uint8Array {
  const m = new Uint8Array(W * H);
  for (let i = 0; i < m.length; i++) m[i] = on(i) ? 1 : 0;
  // Closing with the 4-neighbour cross: dilate, then erode (the grid edge counts as burning, so a fire at the edge
  // is not eaten away).
  const d = new Uint8Array(m.length);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const i = r * W + c;
    d[i] = m[i] | (c > 0 ? m[i - 1] : 0) | (c < W - 1 ? m[i + 1] : 0) | (r > 0 ? m[i - W] : 0) | (r < H - 1 ? m[i + W] : 0);
  }
  const closed = new Uint8Array(m.length);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const i = r * W + c;
    closed[i] = m[i] | (d[i] & (c > 0 ? d[i - 1] : 1) & (c < W - 1 ? d[i + 1] : 1) & (r > 0 ? d[i - W] : 1) & (r < H - 1 ? d[i + W] : 1));
  }
  // Small holes (unburned pockets not reaching the grid edge) filled.
  const holes = components(W, H, (i) => !closed[i]);
  for (let i = 0; i < closed.length; i++) {
    const k = holes.id[i];
    if (k >= 0 && !holes.touchesBorder[k] && holes.size[k] < SMOOTH_MIN_HOLE_CELLS) closed[i] = 1;
  }
  // Small separate parts dropped (never the only part, never one with a `keep` cell).
  const parts = components(W, H, (i) => closed[i] === 1);
  if (parts.size.length > 1) {
    const kept = parts.size.map((s) => s >= SMOOTH_MIN_PART_CELLS);
    if (keep) for (let i = 0; i < keep.length; i++) if (keep[i] && parts.id[i] >= 0) kept[parts.id[i]] = true;
    if (!kept.some(Boolean)) kept[parts.size.indexOf(Math.max(...parts.size))] = true;
    for (let i = 0; i < closed.length; i++) if (parts.id[i] >= 0 && !kept[parts.id[i]]) closed[i] = 0;
  }
  return closed;
}

/**
 * Marching squares over cell centres (threshold 0.5; a saddle joins the two burning cells), so the outline runs
 * through the midpoints between burning and unburning cells: 45° steps instead of 60 m stairs. Rings never cross
 * or touch (rings of different parts stay at least half a cell apart). Coordinates in cell-corner units.
 */
function marchingRings(W: number, H: number, mask: Uint8Array): [number, number][][] {
  const v = (c: number, r: number) => (c < 0 || r < 0 || c >= W || r >= H ? 0 : mask[r * W + c]);
  // Doubled cell-centre coordinates: the square (x, y) has corners at the centres of cells (x, y) .. (x+1, y+1),
  // i.e. (2x, 2y) .. (2x+2, 2y+2); its edge midpoints are T, R, B, L.
  type P = [number, number];
  const T = (x: number, y: number): P => [2 * x + 1, 2 * y], R = (x: number, y: number): P => [2 * x + 2, 2 * y + 1];
  const B = (x: number, y: number): P => [2 * x + 1, 2 * y + 2], L = (x: number, y: number): P => [2 * x, 2 * y + 1];
  type E = typeof T;
  const TABLE: Record<number, [E, E][]> = {
    1: [[L, B]], 2: [[B, R]], 3: [[L, R]], 4: [[T, R]], 5: [[L, T], [R, B]], 6: [[T, B]], 7: [[L, T]], 8: [[L, T]],
    9: [[T, B]], 10: [[T, R], [L, B]], 11: [[T, R]], 12: [[L, R]], 13: [[B, R]], 14: [[L, B]],
  };
  const key = (p: P) => (p[0] + 4) * 1048576 + (p[1] + 4);
  const next = new Map<number, [P, P]>();
  for (let y = -1; y < H; y++) for (let x = -1; x < W; x++) {
    const a = v(x, y), b = v(x + 1, y), c = v(x + 1, y + 1), d = v(x, y + 1);
    const segs = TABLE[a * 8 + b * 4 + c * 2 + d];
    if (!segs) continue;
    const corners: [number, number, number][] = [[2 * x, 2 * y, a], [2 * x + 2, 2 * y, b], [2 * x + 2, 2 * y + 2, c], [2 * x, 2 * y + 2, d]];
    for (const [e1, e2] of segs) {
      let p = e1(x, y), q = e2(x, y);
      // Orient every segment the same way round the burning cells (they are all on one side of it).
      const cross = (cx: number, cy: number) => (q[0] - p[0]) * (cy - p[1]) - (q[1] - p[1]) * (cx - p[0]);
      const on = corners.find(([cx, cy, val]) => val === 1 && cross(cx, cy) !== 0)!;
      if (cross(on[0], on[1]) < 0) [p, q] = [q, p];
      next.set(key(p), [p, q]);
    }
  }
  const rings: [number, number][][] = [];
  const seen = new Set<number>();
  for (const [k0] of next) {
    if (seen.has(k0)) continue;
    const ring: [number, number][] = [];
    let k = k0;
    while (!seen.has(k)) {
      const seg = next.get(k);
      if (!seg) break;
      seen.add(k);
      ring.push([seg[0][0] / 2, seg[0][1] / 2]);
      k = key(seg[1]);
    }
    ring.push(ring[0]);
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}

/** Chaikin corner cutting on a closed ring (`n` rounds). */
export function chaikin(ring: [number, number][], n: number): [number, number][] {
  let pts = ring.slice(0, -1);
  for (let k = 0; k < n; k++) {
    const out: [number, number][] = [];
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
      out.push([0.75 * ax + 0.25 * bx, 0.75 * ay + 0.25 * by], [0.25 * ax + 0.75 * bx, 0.25 * ay + 0.75 * by]);
    }
    pts = out;
  }
  return [...pts, pts[0]];
}

/**
 * The outline drawn on the map for a model area: the mask cleaned (`cleanMask`), traced with marching squares,
 * then two rounds of Chaikin and a light simplification, so a browser forecast looks as calm as a precomputed one
 * (whose contours get buffer(+60 m).buffer(-60 m).simplify(30 m) in Python). Areas and street reach are still
 * computed from the cells, not from this outline.
 */
export function smoothOutline(g: GridGeo, on: (i: number) => boolean, keep?: Uint8Array): Polygon | MultiPolygon | null {
  const W = g.width, H = g.height;
  const mask = cleanMask(W, H, on, keep);
  // Cell-centre coordinates are corner coordinates + 0.5: marchingRings works on doubled centre-based indexes.
  const rings = marchingRings(W, H, mask).map((r) => simplify(chaikin(r.map(([x, y]) => [x + 0.5, y + 0.5] as [number, number]), 2), 0.08));
  if (!rings.length) return null;
  // Outer rings and holes by orientation (the largest ring is an outer one).
  const big = rings.reduce((a, r) => (Math.abs(ringArea(r)) > Math.abs(ringArea(a)) ? r : a));
  const outerSign = Math.sign(ringArea(big));
  const outers = rings.filter((r) => Math.sign(ringArea(r)) === outerSign), holes = rings.filter((r) => Math.sign(ringArea(r)) !== outerSign);
  const polys = outers.map((o) => [o]);
  for (const h of holes) {
    const host = polys.filter((p) => inside(h[0], p[0])).sort((a, b) => Math.abs(ringArea(a[0])) - Math.abs(ringArea(b[0])))[0];
    if (host) host.push(h);
  }
  const toLL = (r: [number, number][]) => r.map(([c, rr]) => { const [lon, lat] = fromCell(g, c, rr); return [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5]; });
  const coords = polys.map((p) => p.map(toLL));
  return coords.length === 1 ? { type: 'Polygon', coordinates: coords[0] } : { type: 'MultiPolygon', coordinates: coords };
}
