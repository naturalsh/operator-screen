/**
 * One GeoJSON update in flight per map source, latest wins.
 *
 * MapLibre 4.7 sends every `setData` to its worker; when they come faster than the worker finishes (dragging the
 * time slider on a phone), older loads are abandoned and the tile reloads can race, leaving a source drawn from an
 * old state for good. Here a source gets its next data only once the previous update has loaded (or after a time
 * limit); updates made meanwhile replace each other, so the map always ends on the newest data. "Loaded": the source
 * has loaded the data and its tiles (or the whole map went idle). Not waiting for the whole map to be idle: during
 * playback it rarely is, and the map would fall seconds behind.
 */
import type { GeoJSONSource, Map as MLMap, MapSourceDataEvent } from 'maplibre-gl';

type Data = Parameters<GeoJSONSource['setData']>[0];

/** Give up waiting for a load after this long and send the newest data anyway. */
const LOAD_LIMIT_MS = 1500;

export class SourceQueue {
  private inFlight = new Map<string, ReturnType<typeof setTimeout>>();
  private pending = new Map<string, Data>();
  private readonly onIdle = () => {
    for (const id of [...this.inFlight.keys()]) this.done(id);
  };
  private readonly onData = (e: MapSourceDataEvent) => {
    if (!this.inFlight.has(e.sourceId) || e.sourceDataType === 'metadata' || !e.isSourceLoaded) return;
    const src = this.map.getSource(e.sourceId) as GeoJSONSource | undefined;
    if (src && !src.loaded()) return;
    this.done(e.sourceId);
  };

  constructor(private readonly map: MLMap) {
    map.on('idle', this.onIdle);
    map.on('sourcedata', this.onData);
  }

  /** Sets the source's data now, or as soon as its previous update has loaded (newer calls replace this one). */
  set(id: string, data: Data): void {
    if (this.inFlight.has(id)) { this.pending.set(id, data); return; }
    const src = this.map.getSource(id) as GeoJSONSource | undefined;
    if (!src) return;
    this.inFlight.set(id, setTimeout(() => this.done(id), LOAD_LIMIT_MS));
    src.setData(data);
    this.map.triggerRepaint();
  }

  /** True while no update is in flight or waiting (for tests and screenshots). */
  idle(): boolean {
    return this.inFlight.size === 0 && this.pending.size === 0;
  }

  private done(id: string): void {
    const timer = this.inFlight.get(id);
    if (timer) clearTimeout(timer);
    this.inFlight.delete(id);
    const next = this.pending.get(id);
    if (next !== undefined) { this.pending.delete(id); this.set(id, next); }
  }

  dispose(): void {
    this.map.off('idle', this.onIdle);
    this.map.off('sourcedata', this.onData);
    for (const t of this.inFlight.values()) clearTimeout(t);
    this.inFlight.clear();
    this.pending.clear();
  }
}
