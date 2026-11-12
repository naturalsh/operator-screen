// Package an offline copy of the basemap for the demo area into public/basemap/.
//
//   node tools/fetch_basemap.mjs            # Marmaris demo area, zoom 0..14
//
// It downloads, from OpenFreeMap (https://openfreemap.org, no API key):
//   - the "dark" style, rewritten to point at the local files,
//   - the vector tiles that cover BBOX at zoom 0..MAX_ZOOM (deeper zooms are overzoomed by MapLibre),
//   - the glyph ranges of the fonts the style uses, and the sprite sheets.
// The app uses this copy when the online style cannot be reached (or with ?basemap=offline).
//
// Map data © OpenStreetMap contributors (ODbL); tile schema © OpenMapTiles (CC-BY); tiles by OpenFreeMap.
import { mkdirSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'basemap');
const STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';
const BBOX = { west: 27.85, south: 36.65, east: 28.45, north: 37.05 }; // fire area + Marmaris + margin
const MAX_ZOOM = 14;
// Latin, Latin Extended-A (Turkish), Greek, Greek Extended, general punctuation.
const GLYPH_RANGES = ['0-255', '256-511', '768-1023', '7936-8191', '8192-8447'];
const SIZE_LIMIT_MB = 100;

const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

async function get(url, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 404 || res.status === 204) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (i + 1 >= tries) throw new Error(`${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
}

function save(rel, buf) {
  const p = join(OUT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, buf);
}

function dirSize(dir) {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    n += e.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return n;
}

async function pool(items, worker, size = 12) {
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < items.length) await worker(items[i++]);
  }));
}

const style = JSON.parse((await get(STYLE_URL)).toString('utf8'));

// --- vector tiles -----------------------------------------------------------------------------
const tilejson = JSON.parse((await get(style.sources.openmaptiles.url)).toString('utf8'));
const template = tilejson.tiles[0];
const tiles = [];
for (let z = 0; z <= MAX_ZOOM; z++) {
  for (let x = lon2x(BBOX.west, z); x <= lon2x(BBOX.east, z); x++) {
    for (let y = lat2y(BBOX.north, z); y <= lat2y(BBOX.south, z); y++) tiles.push([z, x, y]);
  }
}
let fetched = 0;
await pool(tiles, async ([z, x, y]) => {
  const rel = `tiles/${z}/${x}/${y}.pbf`;
  if (existsSync(join(OUT, rel))) return;
  const buf = await get(template.replace('{z}', z).replace('{x}', x).replace('{y}', y));
  // An empty tile (open sea) is stored as a zero-byte file so the map does not report a 404.
  save(rel, buf ?? Buffer.alloc(0));
  fetched += 1;
});
console.log(`tiles: ${tiles.length} (z0..${MAX_ZOOM}), ${fetched} downloaded`);

// --- glyphs and sprites -----------------------------------------------------------------------
const fonts = new Set();
for (const l of style.layers) for (const f of l.layout?.['text-font'] ?? []) fonts.add(f);
fonts.add('Noto Sans Regular'); // used by the app's own label layers
for (const font of fonts) {
  for (const range of GLYPH_RANGES) {
    const buf = await get(style.glyphs.replace('{fontstack}', encodeURIComponent(font)).replace('{range}', range));
    if (buf) save(`fonts/${font}/${range}.pbf`, buf);
  }
}
for (const suffix of ['.json', '.png', '@2x.json', '@2x.png']) {
  const buf = await get(style.sprite + suffix);
  if (buf) save(`sprites/ofm${suffix}`, buf);
}

// --- local style ------------------------------------------------------------------------------
// "{base}" is replaced with the app's absolute base URL when the style is loaded (MapLibre needs absolute URLs).
delete style.sources.ne2_shaded; // world relief raster: not needed at the demo zooms
style.layers = style.layers.filter((l) => l.source !== 'ne2_shaded');
style.sources.openmaptiles = {
  type: 'vector',
  tiles: ['{base}basemap/tiles/{z}/{x}/{y}.pbf'],
  minzoom: 0,
  maxzoom: MAX_ZOOM,
  bounds: [BBOX.west, BBOX.south, BBOX.east, BBOX.north],
  attribution: '<a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/">OpenMapTiles</a> '
    + 'Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · offline copy',
};
style.glyphs = '{base}basemap/fonts/{fontstack}/{range}.pbf';
style.sprite = '{base}basemap/sprites/ofm';
style.metadata = { ...(style.metadata ?? {}), 'nature-shield:offline': true, 'nature-shield:bbox': BBOX,
  'nature-shield:tileset': template, 'nature-shield:fetched_at': new Date().toISOString() };
save('style.json', Buffer.from(JSON.stringify(style)));

const mb = dirSize(OUT) / 1e6;
console.log(`public/basemap: ${mb.toFixed(1)} MB`);
if (mb > SIZE_LIMIT_MB) {
  console.error(`over the ${SIZE_LIMIT_MB} MB limit: lower MAX_ZOOM or shrink BBOX`);
  process.exit(1);
}
