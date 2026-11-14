import { withTimeout } from './latest';
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
 * The packaged basemap is already stored by the service worker (the offline package finished installing): then it
 * is used even online, so a slow network is not loaded with map tiles the browser already has.
 */
async function packagedIsStored(): Promise<boolean> {
  try {
    if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller || !('caches' in window)) return false;
    const base = new URL(import.meta.env.BASE_URL, location.href).href;
    return !!(await caches.match(`${base}basemap/style.json`, { ignoreSearch: true }));
  } catch {
    return false;
  }
}

/**
 * The packaged copy when the offline package has it stored; otherwise the online style when it answers within a
 * few seconds, else the packaged copy. `?basemap=offline` forces the packaged copy (to rehearse without unplugging
 * the network); `?basemap=online` asks for the online one.
 */
export async function resolveBasemap(): Promise<Basemap> {
  const pick = new URLSearchParams(location.search).get('basemap');
  const forced = pick === 'offline' || (pick !== 'online' && await packagedIsStored());
  if (!forced) {
    try {
      const res = await fetch(ONLINE_STYLE, { signal: withTimeout(undefined, ONLINE_TIMEOUT_MS), cache: 'no-store' });
      if (res.ok) return { style: (await res.json()) as StyleSpecification, offline: false };
    } catch {
      // no network: fall through to the offline copy
    }
  }
  const local = await offlineStyle();
  return local ? { style: local, offline: true } : { style: ONLINE_STYLE, offline: false };
}
