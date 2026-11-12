import type { StyleSpecification } from 'maplibre-gl';

/** Online basemap: OpenFreeMap dark vector style (OSM data, no API key). */
const ONLINE_STYLE = 'https://tiles.openfreemap.org/styles/dark';
const ONLINE_TIMEOUT_MS = 3000;

export interface Basemap { style: string | StyleSpecification; offline: boolean }

/** The packaged copy in public/basemap (see tools/fetch_basemap.mjs), or null if it was not packaged. */
async function offlineStyle(): Promise<StyleSpecification | null> {
  const base = new URL(import.meta.env.BASE_URL, location.href).href;
  try {
    const res = await fetch(`${base}basemap/style.json`);
    if (!res.ok) return null;
    return JSON.parse((await res.text()).split('{base}').join(base)) as StyleSpecification;
  } catch {
    return null;
  }
}

/**
 * Use the online style when it answers within a few seconds, otherwise the packaged offline copy.
 * `?basemap=offline` forces the offline copy (to rehearse without unplugging the network).
 */
export async function resolveBasemap(): Promise<Basemap> {
  const forced = new URLSearchParams(location.search).get('basemap') === 'offline';
  if (!forced) {
    try {
      const res = await fetch(ONLINE_STYLE, { signal: AbortSignal.timeout(ONLINE_TIMEOUT_MS), cache: 'no-store' });
      if (res.ok) return { style: (await res.json()) as StyleSpecification, offline: false };
    } catch {
      // no network: fall through to the offline copy
    }
  }
  const local = await offlineStyle();
  return local ? { style: local, offline: true } : { style: ONLINE_STYLE, offline: false };
}
