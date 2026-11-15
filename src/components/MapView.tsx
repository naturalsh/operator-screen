import { quoteHtml } from './ReportQuote';
import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { type ExpressionSpecification, type Map as MLMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  STAGE_COLOUR, STAGE_LABEL, STATUS_COLOUR, STATUS_SHORT, URGENCY_COLOUR, URGENCY_LABEL, URGENCY_ORDER,
  INITIAL_FORECAST_COLOUR, aheadContours, closureAt, closureSource, currentForecast, fireNearby, forecastOnly, forecastReach,
  modelLabel, fmtAge, fmtTime, statusAt, streetLabel, visibleCallers,
} from '../data';
import { resolveBasemap } from '../basemap';
import { CONCEPT_LABEL, STATEMENT_LABEL, circle, type ClusterState } from '../reports';
import { CREW_STATUS_COLOUR, type CrewStatus } from '../crews';
import { SourceQueue } from '../sourceQueue';
import { centre } from '../fires';
import { lookLabel, nowcastSource, type Nowcast } from '../forecast';
import type { CallerReport, FireFront, ScenarioData, Stage, StreetAccess, Urgency } from '../types';

/** A crew vehicle that is away from its station. */
export interface Vehicle { id: string; name: string; status: CrewStatus; position: [number, number]; label: string }

export type LayerKey = 'forecast' | 'initial' | 'observed' | 'streets' | 'nearby' | 'callers' | 'crews' | 'concept';

/** Simple: what a newcomer needs to read the screen. Detailed: every source and distinction. */
export type MapMode = 'simple' | 'detailed';

/** Layers that only exist in Detailed mode. */
const DETAILED_ONLY = ['initial-pending', 'initial-reached', 'initial-label', 'streets-nearby', 'burned-area', 'hotspots-old',
  'forecast-zone-lines', 'forecast-zone-dotted'];
/** Layers that only exist in Simple mode. */
const SIMPLE_ONLY: string[] = [];
/** "Fire now (estimated)": inside, burned ground (dark, low saturation, quiet); along its edge the active front, a
 * band of FRONT_WIDTH_M in one red-orange with thin light edges: the thing the eye should find first. */
export const NOWCAST_COLOUR = '#2a1a14';
export const NOWCAST_OPACITY = 0.5;
export const FRONT_COLOUR = '#f0532b';
export const FRONT_EDGE = '#ffe2d4';
/** The front band: FRONT_COLOUR at 70 % over the dark map, drawn opaque. */
export const FRONT_BAND_COLOUR = '#ae3f22';
export const FRONT_WIDTH_M = 300;
/** The band is at most this share of the fire's equivalent radius (a small fire gets a narrow band)... */
export const FRONT_SHARE_OF_RADIUS = 0.2;
/** ...and below this width only an edge line is drawn. */
export const FRONT_MIN_M = 25;

/** Width of the front band for a fire of `areaKm2`: 20 % of the equivalent radius, at most 300 m; 0 = edge only. */
export function frontWidthM(areaKm2: number): number {
  const w = Math.min(FRONT_WIDTH_M, FRONT_SHARE_OF_RADIUS * Math.sqrt((areaKm2 * 1e6) / Math.PI));
  return w >= FRONT_MIN_M ? w : 0;
}
/** Kept for swatches that show the estimated fire by its edge. */
export const NOWCAST_EDGE = FRONT_COLOUR;
/** The look-ahead line (the one horizon chosen): dashed yellow. Detailed also draws the others, faint. */
export const LOOK_COLOUR = '#facc15';
export const ZONE_COLOUR = { 'h0.5': '#fde68a', h1: '#fde68a', h2: '#fde68a', h3: '#fef3c7', h6: '#fef3c7' } as const;
/** The fire edge the satellites last saw (VIIRS + Sentinel-2): a plain white line. */
export const OBSERVED_COLOUR = '#ffffff';
/** Kept for the legend of the forecast closure and older references. */
export const FORECAST_FILL_COLOUR = '#f97316';
/** Satellite detections. Simple: only the newest VIIRS pass of the last SIMPLE_FIRE_H hours, faint (the burned
 * ground already covers the older ones; several passes over the same ground stacked into dark squares).
 * Detailed: the last ACTIVE_FIRE_H hours bright, older ones dark grey. */
export const ACTIVE_FIRE_H = 6;
export const SIMPLE_FIRE_H = 3;
export const ACTIVE_FIRE_COLOUR = '#fde047';
export const SIMPLE_FIRE_COLOUR = '#ffb547';
export const OLD_FIRE_COLOUR = '#4b5563';

/** Line width in pixels of `metres` on the ground at this map latitude (about 36.85° N), for any zoom. */
function metresWidth(metres: number): ExpressionSpecification {
  const mpp0 = 156543.03 * Math.cos((36.85 * Math.PI) / 180);       // metres per pixel at zoom 0
  return ['interpolate', ['exponential', 2], ['zoom'], 8, (metres * 2 ** 8) / mpp0, 18, (metres * 2 ** 18) / mpp0];
}
/** Streets closed by the forecast only: orange, dashed; observed closures are solid red. */
export const FORECAST_CLOSURE_COLOUR = '#fb923c';

/** Radius around the selected caller and the active routes in which "fire nearby" is drawn. */
const NEARBY_RADIUS_M = 1000;

const LAYER_GROUPS: Record<LayerKey, string[]> = {
  forecast: ['forecast-zone-lines', 'forecast-zone-dotted', 'nowcast-fill', 'front-band', 'front-edges', 'nowcast-spots',
    'lookahead-line', 'observed-line'],
  initial: ['initial-pending', 'initial-reached', 'initial-label'],
  observed: ['hotspots-old', 'hotspots', 'burned-area', 'flame-front'],
  streets: ['streets-near', 'streets', 'streets-forecast'],
  nearby: ['streets-nearby'],
  callers: ['callers-shadow', 'callers-selected', 'callers', 'callers-label'],
  crews: ['routes-casing', 'routes', 'routes-cut', 'responders', 'responders-label'],
  concept: ['report-points', 'cluster-fill', 'cluster-line', 'cluster-line-confirmed', 'cluster-label'],
};

/** Operator-confirmed fires (added on this screen). */
export const OPERATOR_FIRE_COLOUR = '#ff8a1f';

/** CONCEPT DEMO colour (reports from people). */
export const REPORT_COLOUR = '#a78bfa';

/** Report points and candidate discs at the time shown. */
function conceptFc(clusters: ClusterState[]): [GeoJSON.FeatureCollection, GeoJSON.FeatureCollection] {
  const points: GeoJSON.Feature[] = clusters.flatMap((c) => c.reports.map((r) => ({
    type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [r.place.lon, r.place.lat] },
    properties: { id: r.id, cluster: c.cluster.id, candidate: c.candidate },
  })));
  const discs: GeoJSON.Feature[] = clusters.filter((c) => c.candidate).map((c) => ({
    type: 'Feature' as const,
    geometry: circle(c.cluster.lon, c.cluster.lat, c.cluster.radius_m ?? 300),
    properties: { id: c.cluster.id, confirmed: c.confirmedAt != null, p: c.p,
      label: `${c.confirmedAt != null ? 'REPORTED (confirmed)' : 'REPORTED (unconfirmed)'} · P ${c.p.toFixed(2)}` },
  }));
  return [{ type: 'FeatureCollection', features: points }, { type: 'FeatureCollection', features: discs }];
}

const INSTRUMENT_COLOUR = ['match', ['get', 'instrument'], 'MODIS', '#a855f7', 'SLSTR', '#14b8a6', '#ef4444'] as unknown as string;

function callersFc(callers: CallerReport[], stages: Record<string, Stage>,
  urgencyOf: (c: CallerReport) => Urgency): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: callers.map((c) => {
      const stage = stages[c.id] ?? 'new';
      const urgency = urgencyOf(c);
      // Short map label: people at risk only. The place, the stage and the synthetic flag are on the card
      // and in the popup; on the marker the stage is the ring colour.
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [c.place.lon, c.place.lat] },
        properties: { id: c.id, urgency, colour: URGENCY_COLOUR[urgency], stage, ring: STAGE_COLOUR[stage],
          rank: URGENCY_ORDER[urgency], label: c.people_at_risk > 0 ? `${c.people_at_risk} at risk` : '',
          reported_t: Date.parse(c.reported_at) },
      };
    }),
  };
}

interface Props {
  data: ScenarioData;
  now: number;
  layers: Record<LayerKey, boolean>;
  selectedId: string | null;
  nearIds: string[];
  stages: Record<string, Stage>;
  routes: { reportId: string; edgeIds: string[]; cut: boolean }[];
  urgencyOf: (c: CallerReport) => Urgency;
  onSelect: (id: string | null) => void;
  /** Crew vehicles on the road or on scene, at their position for the time shown. */
  vehicles?: Vehicle[];
  mode?: MapMode;
  /** Move the map here when `key` changes (a crew picked in the panel). */
  focus?: { lon: number; lat: number; key: number } | null;
  /** Pixels of the map covered by the phone drawer (bottom, portrait) or side panel (right, landscape);
   * a selected caller is centred in the part that stays visible. */
  insetBottom?: number;
  insetRight?: number;
  /** Start zoomed to the fire (forecast contours) instead of the scenario's default view; used on phones. */
  fitFire?: boolean;
  /** The forecast in force (loaded by the operator); undefined: the latest update in the file. */
  forecastRunId?: string | null;
  /** Change when street closures or fire features change in place (the sources are reloaded). */
  streetsVersion?: number;
  /** CONCEPT DEMO: report clusters at the time shown (empty when the concept layer is off). */
  concept?: ClusterState[];
  fireVersion?: number;
  /** "Fire now (estimated)" and the +1 / +2 / +3 / +6 h horizons from the time shown. */
  nowcast?: Nowcast | null;
  /** The horizon chosen with "Look ahead" (hours; 0 = none). */
  lookAhead?: number;
  /** Called once, when the map has first drawn everything it shows (tiles, data). */
  onFirstIdle?: () => void;
  /** Changes when the clock comes to rest (playback paused, slider released): every layer of ours is redrawn. */
  settleKey?: number;
  /** Called once the map has drawn the redraw asked for by `settleKey` (or after 1.5 s at the latest). */
  onSettled?: () => void;
  /** Operator-confirmed fires on the map at the time shown (geometry and label). */
  operatorFires?: { id: string; geometry: GeoJSON.Polygon; label: string }[];
  /** Points of a fire being drawn ("Add fire"); while set, map clicks add points instead of opening popups. */
  drawing?: [number, number][] | null;
  /** What Confirm would add from the points clicked and the size chosen (previewed on the map). */
  drawingShape?: GeoJSON.Polygon | null;
  onDrawClick?: (lngLat: [number, number]) => void;
  /** An operator fire dragged by its label (move by dLon, dLat) or deleted with its ✕. */
  onMoveFire?: (id: string, dLon: number, dLat: number) => void;
  onDeleteFire?: (id: string) => void;
}

export function MapView({ data, now, layers, selectedId, nearIds, stages, routes, urgencyOf, onSelect, vehicles = [], focus = null, mode = 'simple',
  insetBottom = 0, insetRight = 0, fitFire = false, forecastRunId, streetsVersion = 0, fireVersion = 0, concept = [], nowcast = null, lookAhead = 1, onFirstIdle, settleKey = 0, onSettled,
  operatorFires = [], drawing = null, drawingShape = null, onDrawClick, onMoveFire, onDeleteFire }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const ready = useRef(false);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  // The map showing the packaged basemap (null: online tiles), for the "Packaged basemap" control.
  const [packagedMap, setPackagedMap] = useState<MLMap | null>(null);
  // Streets with a "fire nearby" warning within NEARBY_RADIUS_M of the selected caller or an active route.
  const routesKey = routes.map((r) => `${r.reportId}:${r.edgeIds.length}:${r.edgeIds[0] ?? ''}`).join('|');
  const nearbyIds = useMemo(() => {
    const pts: [number, number][] = [];
    const c = data.callers.find((x) => x.id === selectedId);
    if (c) pts.push([c.place.lon, c.place.lat]);
    const onRoute = new Set(routes.flatMap((r) => r.edgeIds));
    for (const s of data.streets.features) {
      if (!onRoute.has(s.properties.id) || s.geometry.type !== 'LineString') continue;
      const cs = s.geometry.coordinates;
      pts.push(cs[0] as [number, number], cs[cs.length - 1] as [number, number]);
      if (s.properties.label_point) pts.push(s.properties.label_point);
    }
    if (!pts.length) return [];
    const near = (a: [number, number], b: [number, number]) => {
      const k = Math.cos((a[1] * Math.PI) / 180);
      return Math.hypot((a[0] - b[0]) * k, a[1] - b[1]) * 111195 <= NEARBY_RADIUS_M;
    };
    return data.streets.features.filter((s) => s.properties.fire_nearby_at && s.properties.label_point
      && pts.some((p) => near(p, s.properties.label_point!))).map((s) => s.properties.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, selectedId, routesKey]);
  const latest = useRef({ now, layers, selectedId, nearIds, data, stages, routes, urgencyOf, vehicles, mode, nearbyIds, forecastRunId, concept, nowcast, lookAhead });
  latest.current = { now, layers, selectedId, nearIds, data, stages, routes, urgencyOf, vehicles, mode, nearbyIds, forecastRunId, concept, nowcast, lookAhead };
  // The nowcast changes every 30 minutes of scenario time (or when another forecast is in force): reload it then.
  const latestSettled = useRef(onSettled);
  latestSettled.current = onSettled;
  const handlers = useRef({ onDrawClick, onMoveFire, onDeleteFire, drawing });
  handlers.current = { onDrawClick, onMoveFire, onDeleteFire, drawing };
  const nowcastKey = nowcast ? `${nowcast.run.id}|${nowcast.stepAt}|${nowcast.observed?.at}|${lookAhead}|${mode}` : '';
  const vehicleMarkers = useRef(new Map<string, maplibregl.Marker>());

  // Times at which a time-dependent filter or paint can change its result: the map is only told when one of
  // them is crossed (moving the slider between two such times changes nothing on the map, so nothing is sent).
  const fireEvents = useMemo(() => {
    const t = data.fire.features.map((f) => f.properties.t).filter(Number.isFinite);
    return [...t, ...t.map((x) => x + SIMPLE_FIRE_H * 3600000), ...t.map((x) => x + ACTIVE_FIRE_H * 3600000)].sort((a, b) => a - b);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, fireVersion]);
  /** Times of the VIIRS passes (for Simple: only the newest pass of the last few hours is drawn). */
  const viirsTimes = useMemo(() => [...new Set(data.fire.features
    .filter((f) => f.properties.observation_type === 'hotspots' && f.properties.instrument === 'VIIRS').map((f) => f.properties.t as number))].sort((a, b) => a - b),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [data, fireVersion]);
  const streetEvents = useMemo(() => {
    const out: number[] = [];
    for (const f of data.streets.features) {
      const p = f.properties;
      for (const x of [p.t, p.tm, p.ts, p.tn, p.tnear]) if (x != null && x < 9e15) out.push(x);
    }
    return out.sort((a, b) => a - b);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, streetsVersion]);
  /** What was last sent to the map, per group: a group is only updated when its signature changes. */
  const applied = useRef(new Map<string, string>());
  /** Tags of the three lines ("Seen by satellite 04:02", "Fire now (model estimate)", "Expected by 04:55 (+1 h)").
   * DOM markers rebuilt from the current state each time: a symbol layer fed by setData kept drawing old tags after
   * fast slider moves (MapLibre 4.7). */
  const tagMarkers = useRef<maplibregl.Marker[]>([]);
  const placeTags = () => {
    const map = mapRef.current;
    tagMarkers.current.forEach((m) => m.remove());
    tagMarkers.current = [];
    if (!map || !latest.current.layers.forecast) return;
    const fc = nowcastTagPoints(latest.current.nowcast, latest.current.lookAhead, latest.current.mode, latest.current.data.entry.timezone ?? 'UTC');
    for (const f of fc.features) {
      const p = f.properties as { role: string; text: string; side: string };
      const el = document.createElement('div');
      el.className = 'ns-fire-tag';
      el.dataset.role = p.role;
      el.textContent = p.text;
      const anchor = ({ n: 'bottom', s: 'top', e: 'left', w: 'right' } as Record<string, maplibregl.PositionAnchor>)[p.side] ?? 'center';
      tagMarkers.current.push(new maplibregl.Marker({ element: el, anchor, offset: [0, 0] })
        .setLngLat((f.geometry as GeoJSON.Point).coordinates as [number, number]).addTo(map));
    }
  };
  /** GeoJSON updates: one in flight per source, latest wins (see sourceQueue.ts). */
  const queue = useRef<SourceQueue | null>(null);
  const once = (group: string, signature: string, apply: () => void) => {
    if (applied.current.get(group) === signature) return;
    applied.current.set(group, signature);
    apply();
  };

  /** Push the current time, selection and toggles into the map: only what changed since the last call. */
  const sync = () => {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    const { now: t, layers: on, selectedId: sel, nearIds: near, data: d, stages: st, routes: rts, urgencyOf: uo } = latest.current;
    const upTo: ExpressionSpecification = ['<=', ['get', 't'], t];
    const kind = (k: string): ExpressionSpecification => ['==', ['get', 'kind'], k];
    const obs = (o: string): ExpressionSpecification => ['==', ['get', 'observation_type'], o];
    const simple = latest.current.mode === 'simple';
    const mode = latest.current.mode;
    // "Fire now (estimated)" and the horizons from now come from their own source (see the nowcast effect).
    const cur = currentForecast(d.fire.features.map((f) => f.properties), t, latest.current.forecastRunId);
    const fireStep = countUpTo(fireEvents, t);
    once('fire', `${fireStep}|${mode}|${cur?.set ?? ''}|${!!latest.current.nowcast}`, () => {
      // Optional: the single forecast made at ignition, for comparison (only when updates exist).
      const initial: ExpressionSpecification = ['all', kind('forecast'), ['==', ['get', 'set'], cur?.set === 'update' || latest.current.nowcast ? 'initial' : 'none']];
      map.setFilter('initial-reached', ['all', initial, upTo]);
      map.setFilter('initial-label', ['all', initial, upTo]);
      map.setFilter('initial-pending', ['all', initial, ['>', ['get', 't'], t]]);
      // Satellite detections: the last ACTIVE_FIRE_H hours are active fire (bright), older ones burned (dark grey).
      const recent: ExpressionSpecification = ['>', ['get', 't'], t - ACTIVE_FIRE_H * 3600000];
      // Simple: only the newest VIIRS pass of the last SIMPLE_FIRE_H hours (the 1 km pixels are large squares that hide
      // the map; pixels of several passes on the same ground stacked their 30 % into dark squares, and the burned area
      // and fire now already cover the older ones).
      const newestViirs = [...viirsTimes].reverse().find((x) => x <= t && x > t - SIMPLE_FIRE_H * 3600000) ?? -1;
      map.setFilter('hotspots', simple
        ? ['all', obs('hotspots'), ['==', ['get', 't'], newestViirs], ['==', ['get', 'instrument'], 'VIIRS']]
        : ['all', obs('hotspots'), upTo, recent]);
      map.setFilter('flame-front', simple ? ['all', obs('flame_front'), upTo, ['>', ['get', 't'], t - SIMPLE_FIRE_H * 3600000]]
        : ['all', obs('flame_front'), upTo]);
      map.setFilter('burned-area', ['all', obs('burned_area'), upTo]);
      // Active fire: one bright colour in Simple, the sensor colours in Detailed.
      map.setPaintProperty('hotspots', 'fill-color', simple ? SIMPLE_FIRE_COLOUR : INSTRUMENT_COLOUR);
      map.setPaintProperty('hotspots', 'fill-opacity', ['match', ['get', 'instrument'], 'VIIRS', simple ? 0.3 : 0.4, simple ? 0.1 : 0.15]);
      map.setPaintProperty('hotspots', 'fill-outline-color', simple ? 'rgba(0,0,0,0)' : INSTRUMENT_COLOUR);
      // Older detections (burned): dark grey, Detailed only.
      map.setFilter('hotspots-old', ['all', obs('hotspots'), upTo, ['!', recent]]);
      map.setPaintProperty('flame-front', 'fill-color', simple ? SIMPLE_FIRE_COLOUR : ['case', recent, ACTIVE_FIRE_COLOUR, OLD_FIRE_COLOUR]);
      map.setPaintProperty('flame-front', 'fill-opacity', simple ? 0.35 : ['case', recent, 0.9, 0.5]);
      map.setPaintProperty('flame-front', 'fill-outline-color', simple ? 'rgba(0,0,0,0)' : '#fef08a');
    });
    // The front band scales with the fire: a small fire gets a narrow band, a very small one only an edge line
    // (a 300 m band around a fire a few hundred metres across folded over itself).
    const nowArea = latest.current.nowcast?.fc.features.find((f) => f.properties.role === 'now')?.properties.area_km2 ?? 0;
    const w = frontWidthM(nowArea);
    once('front', String(Math.round(w)), () => {
      map.setPaintProperty('front-band', 'line-width', w ? metresWidth(w) : 0);
      map.setPaintProperty('front-edges', 'line-gap-width', w ? metresWidth(w) : 0);
      map.setPaintProperty('front-edges', 'line-color', w ? FRONT_EDGE : FRONT_COLOUR);
      map.setPaintProperty('front-edges', 'line-width', w ? 1.6 : 1.8);
      map.setPaintProperty('front-edges', 'line-opacity', w ? 0.75 : 0.95);
      (window as unknown as { __nsFrontWidthM?: number }).__nsFrontWidthM = w;    // for tests
    });
    // Look ahead: one horizon, dashed; Detailed also draws the other horizons faint.
    const look = `h${latest.current.lookAhead}`;
    once('look', look, () => {
      map.setFilter('lookahead-line', ['==', ['get', 'role'], look]);
      map.setFilter('forecast-zone-lines', ['all', ['match', ['get', 'role'], ['h0.5', 'h1', 'h2', 'h3'], true, false], ['!=', ['get', 'role'], look]]);
      map.setFilter('forecast-zone-dotted', ['all', ['==', ['get', 'role'], 'h6'], ['!=', ['get', 'role'], look]]);
    });
    once('near', near.join(','), () => map.setFilter('streets-near', ['in', ['get', 'id'], ['literal', near]]));
    const streetStep = countUpTo(streetEvents, t);
    once('streets', `${streetStep}|${streetsVersion}|${latest.current.nearbyIds.join(',')}`, () => {
      // Closed by the forecast only (no satellite detection yet): a forecast closure, orange dashed in both modes.
      const forecastOnlyExpr: ExpressionSpecification = ['all', ['<=', ['coalesce', ['get', 'tm'], 9e15], t], ['>', ['coalesce', ['get', 'ts'], 9e15], t]];
      map.setFilter('streets-forecast', forecastOnlyExpr);
      map.setFilter('streets', ['!', forecastOnlyExpr]);
      // Fire nearby: a coarse pixel covers the street and neither source has closed it yet.
      map.setFilter('streets-nearby', ['all', ['<=', ['coalesce', ['get', 'tn'], 9e15], t],
        ['>', ['coalesce', ['get', 'tm'], 9e15], t], ['>', ['coalesce', ['get', 'ts'], 9e15], t],
        ['in', ['get', 'id'], ['literal', latest.current.nearbyIds]]]);
      // Streets the fire has not come near yet are barely visible.
      map.setPaintProperty('streets', 'line-opacity', ['case', ['<=', ['coalesce', ['get', 'tnear'], 9e15], t], 1, 0.07]);
      map.setPaintProperty('streets', 'line-color', ['match',
        ['case', ['<=', ['get', 't'], t], ['get', 'status'], ['get', 'before']],
        'open', STATUS_COLOUR.open, 'special_access', STATUS_COLOUR.special_access, STATUS_COLOUR.blocked]);
    });
    once('selected', sel ?? '', () => map.setFilter('callers-selected', ['all', ['<=', ['get', 'reported_t'], t], ['==', ['get', 'id'], sel ?? '']]));
    const concept = latest.current.concept;
    once('concept', concept.map((c) => `${c.cluster.id}:${c.reports.length}:${c.candidate}:${c.confirmedAt != null}:${c.p.toFixed(2)}`).join(','), () => {
      const [reportPts, discs] = conceptFc(concept);
      queue.current?.set('report-points', reportPts);
      queue.current?.set('clusters', discs);
    });
    // Callers: every report is in the source from the start; the filter shows those received by now and the
    // operator's stage and urgency are feature state. Nothing is re-sent to the map's worker when time moves.
    const visible = visibleCallers(d.callers, t);
    once('callers', String(visible.length), () => {
      const shown: ExpressionSpecification = ['<=', ['get', 'reported_t'], t];
      for (const id of ['callers-shadow', 'callers', 'callers-label']) map.setFilter(id, shown);
      map.setFilter('callers-selected', ['all', shown, ['==', ['get', 'id'], sel ?? '']]);
      applied.current.delete('selected');
    });
    once('caller-state', d.callers.map((c) => `${st[c.id] ?? 'new'}:${uo(c)}`).join(','), () => {
      for (const c of d.callers) {
        const stage = st[c.id] ?? 'new';
        const urgency = uo(c);
        map.setFeatureState({ source: 'callers', id: c.id }, { stage, ring: STAGE_COLOUR[stage], urgency, colour: URGENCY_COLOUR[urgency] });
      }
    });
    const ok = rts.filter((r) => !r.cut).flatMap((r) => r.edgeIds);
    const cut = rts.filter((r) => r.cut).flatMap((r) => r.edgeIds);
    once('routes', `${ok.join(',')}|${cut.join(',')}`, () => {
      map.setFilter('routes-casing', ['in', ['get', 'id'], ['literal', [...ok, ...cut]]]);
      map.setFilter('routes', ['in', ['get', 'id'], ['literal', ok]]);
      map.setFilter('routes-cut', ['in', ['get', 'id'], ['literal', cut]]);
    });
    // Crew vehicles: one DOM marker each, moved to the crew's position for the time shown.
    const shown = on.crews ? latest.current.vehicles : [];
    for (const [id, marker] of vehicleMarkers.current) {
      if (!shown.some((v) => v.id === id)) { marker.remove(); vehicleMarkers.current.delete(id); }
    }
    for (const v of shown) {
      let marker = vehicleMarkers.current.get(v.id);
      if (!marker) {
        const el = document.createElement('div');
        el.className = 'ns-vehicle';
        el.dataset.vehicle = v.id;
        el.innerHTML = '<svg viewBox="0 0 28 18" width="30" height="20" aria-hidden="true">'
          + '<rect x="1" y="3" width="17" height="10" rx="1.5" class="ns-vehicle-body"/><path d="M18 6h5l4 4v3h-9z" class="ns-vehicle-body"/>'
          + '<circle cx="7" cy="14" r="3" fill="#07090d" stroke="#fff" stroke-width="1"/><circle cx="21" cy="14" r="3" fill="#07090d" stroke="#fff" stroke-width="1"/></svg>'
          + '<span class="ns-vehicle-label"></span>';
        marker = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(v.position).addTo(map);
        vehicleMarkers.current.set(v.id, marker);
      }
      marker.setLngLat(v.position);
      const el = marker.getElement();
      el.dataset.status = v.status;
      el.style.setProperty('--vehicle', CREW_STATUS_COLOUR[v.status]);
      el.querySelector('.ns-vehicle-label')!.textContent = `${v.name} · ${v.label}`;
    }
    once('visibility', `${mode}|${JSON.stringify(on)}`, () => {
      for (const [key, ids] of Object.entries(LAYER_GROUPS) as [LayerKey, string[]][]) {
        for (const id of ids) {
          const shownHere = on[key] && !(simple ? DETAILED_ONLY.includes(id) : SIMPLE_ONLY.includes(id));
          map.setLayoutProperty(id, 'visibility', shownHere ? 'visible' : 'none');
        }
      }
    });
  };

  useEffect(() => {
    let cancelled = false;
    let created: MLMap | null = null;
    resolveBasemap().then((basemap) => {
    if (cancelled) return;
    const map = new maplibregl.Map({
      container: container.current!,
      style: basemap.style,
      center: data.entry.center,
      zoom: data.entry.zoom,
      attributionControl: { compact: true },
      preserveDrawingBuffer: true, // lets the canvas be captured (screenshots)
    });
    mapRef.current = map;
    created = map;
    setPackagedMap(basemap.offline ? map : null);
    if (fitFire) {
      // Bounding box of the forecast contours, so a narrow screen starts on the fire.
      const box = new maplibregl.LngLatBounds();
      const add = (c: unknown): void => {
        if (Array.isArray(c) && typeof c[0] === 'number') box.extend(c as [number, number]);
        else if (Array.isArray(c)) c.forEach(add);
      };
      // Only the forecast in force at the time shown (later forecasts are not known yet).
      const cur = currentForecast(data.fire.features.map((f) => f.properties), latest.current.now, latest.current.forecastRunId);
      const ids = new Set(cur?.contours.map((c) => c.id) ?? []);
      for (const f of data.fire.features) if (ids.has(f.properties.id) && 'coordinates' in f.geometry) add(f.geometry.coordinates);
      if (box.isEmpty() && data.fireMeta.ignition) box.extend([data.fireMeta.ignition.lon, data.fireMeta.ignition.lat]);
      if (!box.isEmpty()) map.fitBounds(box, { padding: { top: 24, left: 24, right: 24 + insetRight, bottom: 24 + insetBottom }, animate: false });
    }
    // A caller selected before the map existed (`?call=`, `?demo=1`): start on it.
    const sel = data.callers.find((x) => x.id === latest.current.selectedId);
    if (sel) map.jumpTo({ center: [sel.place.lon, sel.place.lat], zoom: Math.max(map.getZoom(), 13.2) });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

    map.on('load', () => {
      map.addSource('fire', { type: 'geojson', data: data.fire });
      map.addSource('nowcast', { type: 'geojson', data: latest.current.nowcast?.fc ?? { type: 'FeatureCollection', features: [] } });
      map.addSource('streets', { type: 'geojson', data: data.streets });
      map.addSource('callers', { type: 'geojson', data: callersFc(data.callers, {}, (c) => c.urgency), promoteId: 'id' });
      map.addSource('responders', { type: 'geojson', data: {
        type: 'FeatureCollection',
        features: data.responders.map((r) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.place.lon, r.place.lat] },
          properties: { id: r.id, name: r.name, kind: r.kind } })),
      } });

      // Older detections (burned) at the bottom, then the horizons from now, the estimated fire now, and the
      // active fire of the last hours on top of it. All under the streets, so roads stay readable.
      map.addLayer({ id: 'hotspots-old', type: 'fill', source: 'fire',
        paint: { 'fill-color': OLD_FIRE_COLOUR, 'fill-opacity': ['match', ['get', 'instrument'], 'VIIRS', 0.32, 0.05] } });
      map.addLayer({ id: 'nowcast-fill', type: 'fill', source: 'nowcast', filter: ['==', ['get', 'role'], 'now'],
        paint: { 'fill-color': NOWCAST_COLOUR, 'fill-opacity': NOWCAST_OPACITY } });
      map.addLayer({ id: 'hotspots', type: 'fill', source: 'fire',
        paint: { 'fill-color': INSTRUMENT_COLOUR, 'fill-opacity': ['match', ['get', 'instrument'], 'VIIRS', 0.3, 0.1] } });
      map.addLayer({ id: 'burned-area', type: 'line', source: 'fire',
        paint: { 'line-color': '#9ca3af', 'line-width': 1.5, 'line-opacity': 0.8 } });
      map.addLayer({ id: 'flame-front', type: 'fill', source: 'fire',
        paint: { 'fill-color': ACTIVE_FIRE_COLOUR, 'fill-opacity': 0.9, 'fill-outline-color': '#fef08a' } });
      // Detailed only: the horizons not chosen, thin and faint (+6 h dotted).
      map.addLayer({ id: 'forecast-zone-lines', type: 'line', source: 'nowcast', filter: ['==', ['get', 'role'], 'none'],
        layout: { 'line-join': 'round' },
        paint: { 'line-color': ZONE_COLOUR.h2, 'line-width': 1, 'line-opacity': 0.45 } });
      map.addLayer({ id: 'forecast-zone-dotted', type: 'line', source: 'nowcast', filter: ['==', ['get', 'role'], 'h6'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ZONE_COLOUR.h6, 'line-width': 1.4, 'line-opacity': 0.55, 'line-dasharray': [0.1, 2.5] } });

      map.addLayer({ id: 'streets-near', type: 'line', source: 'streets',
        layout: { 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 9, 'line-opacity': 0.9 } });
      // "Fire nearby (satellite)": an amber halo under streets a 1 km pixel covers but nothing has closed.
      map.addLayer({ id: 'streets-nearby', type: 'line', source: 'streets',
        paint: { 'line-color': '#fbbf24', 'line-opacity': 0.75,
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 5, 14, 11] } });
      map.addLayer({ id: 'streets', type: 'line', source: 'streets', layout: { 'line-cap': 'round' },
        paint: {
          'line-color': STATUS_COLOUR.open,
          // Streets far from the fire stay on the map for routing but are drawn faint.
          // Set in sync(): streets no forecast so far has come near are barely visible.
          'line-opacity': 1,
          'line-width': ['interpolate', ['linear'], ['zoom'],
            10, ['match', ['get', 'highway'], 'track', 0.8, 1.8],
            14, ['match', ['get', 'highway'], 'track', 2.2, 4.5]],
        } });

      // Forecast closures: the forecast in force reaches the street but no satellite has seen fire there yet.
      map.addLayer({ id: 'streets-forecast', type: 'line', source: 'streets',
        paint: { 'line-color': FORECAST_CLOSURE_COLOUR, 'line-dasharray': [1.6, 1.4],
          'line-width': ['interpolate', ['linear'], ['zoom'],
            10, ['match', ['get', 'highway'], 'track', 1.2, 2.2],
            14, ['match', ['get', 'highway'], 'track', 2.6, 4.5]] } });

      // The active front: a band of FRONT_WIDTH_M along the edge of the estimated fire (half inside, half outside: the
      // edge is an estimate), one colour, with thin light edges. Under the routes and callers.
      // The light edges go under the opaque band, twice as wide: the half outside the band shows, while the loops a
      // wide line's edge makes at tight inner bends stay hidden under the band.
      map.addLayer({ id: 'front-edges', type: 'line', source: 'nowcast', filter: ['==', ['get', 'role'], 'now'],
        layout: { 'line-join': 'round' },
        paint: { 'line-color': FRONT_EDGE, 'line-opacity': 0.75, 'line-width': 1.6, 'line-gap-width': metresWidth(FRONT_WIDTH_M) } });
      map.addLayer({ id: 'front-band', type: 'line', source: 'nowcast', filter: ['==', ['get', 'role'], 'now'],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        // Opaque, in the colour the 70 % band had over the dark map: a see-through wide line draws its overlaps at
        // bends twice (bright wedges at every sharp corner of the outline).
        paint: { 'line-color': FRONT_BAND_COLOUR, 'line-opacity': 1, 'line-width': metresWidth(FRONT_WIDTH_M) } });
      // Small separate parts of the estimated fire: a small mark, no front band.
      map.addLayer({ id: 'nowcast-spots', type: 'circle', source: 'nowcast', filter: ['==', ['get', 'role'], 'spot'],
        paint: { 'circle-radius': 3, 'circle-color': FRONT_COLOUR, 'circle-opacity': 0.85, 'circle-stroke-color': FRONT_EDGE, 'circle-stroke-width': 0.8 } });
      // The look-ahead line: the expected fire edge at the chosen horizon, dashed yellow.
      map.addLayer({ id: 'lookahead-line', type: 'line', source: 'nowcast', filter: ['==', ['get', 'role'], 'none'],
        layout: { 'line-join': 'round' },
        paint: { 'line-color': LOOK_COLOUR, 'line-width': 2.2, 'line-opacity': 0.95, 'line-dasharray': [2.2, 1.6] } });
      // Observation: the fire edge the satellites last saw, a plain white line on top of the estimate.
      map.addLayer({ id: 'observed-line', type: 'line', source: 'nowcast', filter: ['==', ['get', 'role'], 'obs'],
        layout: { 'line-join': 'round' },
        paint: { 'line-color': OBSERVED_COLOUR, 'line-width': 2, 'line-opacity': 0.95 } });

      // Crew routes: drawn over the streets; a route cut by a newly blocked street turns dashed amber.
      map.addLayer({ id: 'routes-casing', type: 'line', source: 'streets', layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#083344', 'line-width': 9, 'line-opacity': 0.9 } });
      map.addLayer({ id: 'routes', type: 'line', source: 'streets', layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#22d3ee', 'line-width': 5 } });
      map.addLayer({ id: 'routes-cut', type: 'line', source: 'streets',
        paint: { 'line-color': '#fbbf24', 'line-width': 5, 'line-dasharray': [1.2, 1.2] } });

      map.addLayer({ id: 'initial-pending', type: 'line', source: 'fire',
        paint: { 'line-color': INITIAL_FORECAST_COLOUR, 'line-width': 1.2, 'line-dasharray': [2, 3], 'line-opacity': 0.6 } });
      map.addLayer({ id: 'initial-reached', type: 'line', source: 'fire',
        paint: { 'line-color': INITIAL_FORECAST_COLOUR, 'line-width': 2.2 } });
      map.addLayer({ id: 'initial-label', type: 'symbol', source: 'fire',
        layout: { 'symbol-placement': 'line', 'text-field': ['concat', 'initial +', ['to-string', ['get', 'horizon_hours']], ' h'],
          'text-font': ['Noto Sans Regular'], 'text-size': 11, 'symbol-spacing': 400 },
        paint: { 'text-color': INITIAL_FORECAST_COLOUR, 'text-halo-color': '#07090d', 'text-halo-width': 1.5 } });
      map.addLayer({ id: 'responders', type: 'circle', source: 'responders',
        paint: { 'circle-radius': 8, 'circle-color': '#0e7490', 'circle-stroke-color': '#a5f3fc', 'circle-stroke-width': 2.5 } });
      map.addLayer({ id: 'responders-label', type: 'symbol', source: 'responders',
        layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11,
          'text-offset': [0, -1.4], 'text-anchor': 'bottom', 'text-allow-overlap': false, 'text-padding': 4 },
        paint: { 'text-color': '#a5f3fc', 'text-halo-color': '#07090d', 'text-halo-width': 1.5 } });

      // A soft dark shadow under each caller, so the dots stay readable on the fire.
      map.addLayer({ id: 'callers-shadow', type: 'circle', source: 'callers',
        paint: { 'circle-radius': ['match', ['coalesce', ['feature-state', 'urgency'], ['get', 'urgency']], 'life_threat', 13, 'urgent', 11.5, 10], 'circle-color': '#000000',
          'circle-opacity': 0.45, 'circle-blur': 0.6 } });
      map.addLayer({ id: 'callers-selected', type: 'circle', source: 'callers',
        paint: { 'circle-radius': 17, 'circle-color': 'rgba(255,255,255,0.15)', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 } });
      map.addLayer({ id: 'callers', type: 'circle', source: 'callers',
        paint: { 'circle-radius': ['match', ['coalesce', ['feature-state', 'urgency'], ['get', 'urgency']], 'life_threat', 9, 'urgent', 7.5, 6],
          'circle-color': ['coalesce', ['feature-state', 'colour'], ['get', 'colour']],
          // A new caller has a thin white edge; once handled the ring takes the stage colour.
          'circle-stroke-color': ['match', ['coalesce', ['feature-state', 'stage'], 'new'], 'new', '#ffffff', ['coalesce', ['feature-state', 'ring'], '#ffffff']],
          'circle-stroke-width': ['match', ['coalesce', ['feature-state', 'stage'], 'new'], 'new', 1.5, 'taken', 2.5, 3.5] } });
      // CONCEPT DEMO: reports from people (points) and candidate clusters (uncertainty discs, dashed until confirmed).
      map.addSource('report-points', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('clusters', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'cluster-fill', type: 'fill', source: 'clusters',
        paint: { 'fill-color': REPORT_COLOUR, 'fill-opacity': ['case', ['get', 'confirmed'], 0.22, 0.1] } });
      map.addLayer({ id: 'cluster-line', type: 'line', source: 'clusters', filter: ['!', ['get', 'confirmed']],
        paint: { 'line-color': REPORT_COLOUR, 'line-width': 2, 'line-dasharray': [2, 1.5] } });
      map.addLayer({ id: 'cluster-line-confirmed', type: 'line', source: 'clusters', filter: ['get', 'confirmed'],
        paint: { 'line-color': REPORT_COLOUR, 'line-width': 2.5 } });
      map.addLayer({ id: 'report-points', type: 'circle', source: 'report-points',
        paint: { 'circle-radius': ['case', ['get', 'candidate'], 4, 3], 'circle-color': REPORT_COLOUR,
          'circle-opacity': ['case', ['get', 'candidate'], 0.95, 0.5], 'circle-stroke-color': '#07090d', 'circle-stroke-width': 1 } });
      map.addLayer({ id: 'cluster-label', type: 'symbol', source: 'clusters',
        layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-anchor': 'bottom',
          'text-offset': [0, -1.2], 'text-allow-overlap': true },
        paint: { 'text-color': '#ddd6fe', 'text-halo-color': '#07090d', 'text-halo-width': 1.5 } });
      map.addLayer({ id: 'callers-label', type: 'symbol', source: 'callers',
        // Labels that would collide are hidden (most urgent kept); they appear when zooming in.
        layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 11,
          'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-allow-overlap': false, 'text-ignore-placement': false,
          'text-padding': 4, 'symbol-sort-key': ['get', 'rank'] },
        paint: { 'text-color': '#f2f6fb', 'text-halo-color': '#07090d', 'text-halo-width': 1.5 } });

      // Operator-confirmed fires: orange area with a white dashed edge (apart from the model's front and the
      // satellites), and a fire being drawn (points and the polygon so far).
      map.addSource('operator-fires', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('draft', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'opfire-fill', type: 'fill', source: 'operator-fires', paint: { 'fill-color': OPERATOR_FIRE_COLOUR, 'fill-opacity': 0.45 } }, 'callers-shadow');
      map.addLayer({ id: 'opfire-line', type: 'line', source: 'operator-fires', layout: { 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-dasharray': [2, 1.2] } }, 'callers-shadow');
      map.addLayer({ id: 'draft-fill', type: 'fill', source: 'draft', filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': OPERATOR_FIRE_COLOUR, 'fill-opacity': 0.3 } });
      map.addLayer({ id: 'draft-line', type: 'line', source: 'draft', filter: ['!=', ['geometry-type'], 'Point'],
        paint: { 'line-color': '#ffffff', 'line-width': 1.5, 'line-dasharray': [1, 1] } });
      map.addLayer({ id: 'draft-points', type: 'circle', source: 'draft', filter: ['==', ['geometry-type'], 'Point'],
        paint: { 'circle-radius': 5, 'circle-color': OPERATOR_FIRE_COLOUR, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } });

      const ign = data.fireMeta.ignition;
      if (ign) {
        const el = document.createElement('div');
        el.textContent = '★';
        el.title = ign.label ?? 'Ignition';
        el.style.cssText = 'font-size:22px;color:#fff;text-shadow:0 0 4px #000;line-height:1';
        new maplibregl.Marker({ element: el }).setLngLat([ign.lon, ign.lat]).addTo(map);
      }

      // One click handler, most specific feature first: caller, response point, street, fire front.
      const CLICKABLE = ['callers', 'report-points', 'cluster-fill', 'responders', 'streets', 'streets-forecast', 'flame-front', 'hotspots',
        'observed-line', 'lookahead-line', 'front-band', 'nowcast-spots', 'nowcast-fill', 'forecast-zone-lines', 'forecast-zone-dotted',
        'initial-reached', 'initial-pending', 'burned-area', 'hotspots-old'];
      const muted = (text: string) => `<div class="ns-muted">${text}</div>`;
      const tag = (p: { synthetic?: boolean; basis?: string }) => (p.synthetic ? '<span class="synthetic-tag">SYNTHETIC</span>'
        : p.basis === 'fire_model' ? '<span class="model-tag">MODEL OUTPUT</span>'
          : p.basis === 'satellite' ? '<span class="model-tag">SATELLITE</span>'
            : p.basis === 'fire_model_and_satellite' ? `<span class="model-tag">${modelLabel(latest.current.data.streetsMeta)}</span>` : '');
      map.on('click', (e) => {
        // Drawing a fire: the click is a point of it, nothing else.
        if (handlers.current.drawing) { handlers.current.onDrawClick?.([e.lngLat.lng, e.lngLat.lat]); return; }
        const hit = map.queryRenderedFeatures(e.point, { layers: CLICKABLE.filter((id) => map.getLayer(id)) })
          .sort((a, b) => CLICKABLE.indexOf(a.layer.id) - CLICKABLE.indexOf(b.layer.id))[0];
        if (!hit) return;
        const { now: t, data: d, stages: st, urgencyOf: uo } = latest.current;
        const tz = d.entry.timezone ?? 'UTC';
        let html = '';
        let at: [number, number] = [e.lngLat.lng, e.lngLat.lat];
        if (hit.layer.id === 'report-points' || hit.layer.id === 'cluster-fill') {
          const cid = hit.layer.id === 'cluster-fill' ? hit.properties.id : hit.properties.cluster;
          const c = latest.current.concept.find((x) => x.cluster.id === cid);
          if (!c) return;
          html = `<b>${c.candidate ? (c.confirmedAt != null ? 'REPORTED (confirmed)' : 'REPORTED (unconfirmed)') : 'Fire report (below threshold)'}</b>`
            + `<div>P ${c.p.toFixed(2)} · ${c.sources} independent source${c.sources === 1 ? '' : 's'} · ${c.reports.length} report${c.reports.length === 1 ? '' : 's'}</div>`
            + c.reports.map((r) => muted(`${fmtTime(Date.parse(r.observed_at), tz)} · ${STATEMENT_LABEL[r.statement_class]} · ±${r.place.uncertainty_m} m`)).join('')
            + (c.candidate ? '' : muted('One independent source or P < 0.5: not a candidate.'))
            + `<div style="margin-top:4px"><span class="concept-tag">CONCEPT DEMO</span></div>`
            + muted(CONCEPT_LABEL);
        } else if (hit.layer.id === 'callers') {
          const c = d.callers.find((x) => x.id === hit.properties.id);
          if (!c) return;
          onSelect(c.id);
          at = [c.place.lon, c.place.lat];
          const u = uo(c);
          html = `<b>${c.place.label ?? 'Caller'}</b>`
            + `<div><span style="color:${URGENCY_COLOUR[u]}">●</span> ${URGENCY_LABEL[u]} · ${STAGE_LABEL[st[c.id] ?? 'new']}`
            + `${c.people_at_risk > 0 ? ` · ${c.people_at_risk} at risk` : ''}</div>`
            + quoteHtml(c)
            + muted(`${fmtTime(Date.parse(c.reported_at), tz)} · ${c.language.toUpperCase()}${c.channel ? ` · ${c.channel}` : ''}`)
            + tag(c);
        } else if (hit.layer.id === 'responders') {
          const r = d.responders.find((x) => x.id === hit.properties.id);
          if (!r) return;
          at = [r.place.lon, r.place.lat];
          html = `<b>${r.name}</b><div>${r.kind.replace('_', ' ')} · response point</div>`
            + muted(`Location: ${r.source} (${r.place.lat.toFixed(4)}° N, ${r.place.lon.toFixed(4)}° E)`)
            + muted('Crew availability here is an assumption of the demo.');
        } else if (hit.layer.id === 'streets' || hit.layer.id === 'streets-forecast') {
          // Rendered features carry nested values (label_point) as JSON text, so read the street from the data.
          const p = d.streets.features.find((f) => f.properties.id === hit.properties.id)?.properties
            ?? (hit.properties as StreetAccess);
          const now = statusAt(p, t);
          const closure = closureAt(p, t);
          html = `<b>${streetLabel(p)}</b>` + muted(`${p.highway ?? 'road'} · OSM way ${p.osm_way_id}`)
            + (forecastOnly(closure)
              ? `<div><span style="color:${FORECAST_CLOSURE_COLOUR}">■</span> Forecast closure`
              : `<div><span style="color:${STATUS_COLOUR[now]}">■</span> ${STATUS_SHORT[now]}`)
            + (p.free_width_m != null ? `, free width ${p.free_width_m} m` : '')
            + (closure ? ` since ${fmtTime(closure.since, tz)} — ${closureSource(p, closure)}`
              : (p.t ?? 0) > 0 && (p.t ?? 0) <= t && p.status !== p.before ? ` since ${fmtTime(p.t!, tz)}` : '') + '</div>'
            + (closure?.by === 'both' ? muted(`model from ${fmtTime(p.tm!, tz)} · satellite from ${fmtTime(p.ts!, tz)}`) : '')
            + (() => {
              // Not closed yet: only what the forecast in force says, never what will happen.
              if (closure) return '';
              const run = latest.current.nowcast?.run;
              if (run) {
                // Same reach time as forecast closures and route warnings (150 m buffer, to the half hour).
                const at = run.reach.get(p.id);
                return at != null && at > t ? `<div>Forecast (issued ${fmtTime(run.issuedAt, tz)}): fire may reach this street by `
                  + `${fmtTime(at, tz)}</div>` : '';
              }
              const feature = d.streets.features.find((f) => f.properties.id === p.id);
              const reach = feature ? forecastReach(feature, aheadContours(d.fire.features, t, latest.current.forecastRunId)) : null;
              return reach ? `<div>Forecast (issued ${fmtTime(reach.issuedAt, tz)}): fire may reach this street by `
                + `${fmtTime(reach.at, tz)} (+${reach.horizon} h)</div>` : '';
            })()
            + (fireNearby(p, t) ? `<div style="color:#fbbf24">⚠ Fire nearby (satellite): ${p.fire_nearby_source ?? '1 km pixel'} `
              + `since ${fmtTime(p.tn!, tz)}. 1 km pixel, too coarse to close the street.</div>` : '')
            + (closure && (p.tm ?? 9e15) <= t && p.model_reason ? muted(p.model_reason) : '')
            + (closure && (p.ts ?? 9e15) <= t && (p.satellite_reason ?? p.reason) ? muted(p.satellite_reason ?? p.reason ?? '') : '')
            + (p.imagery_date ? muted(`Imagery: ${p.imagery_date}`) : '')
            + muted(p.confirmed_by_operator ? 'Confirmed by operator' : 'Not confirmed by an operator') + tag(p);
        } else if (['observed-line', 'lookahead-line', 'front-band', 'nowcast-spots', 'nowcast-fill', 'forecast-zone-lines', 'forecast-zone-dotted'].includes(hit.layer.id)) {
          const nc = latest.current.nowcast;
          if (!nc) return;
          const role = hit.properties.role as string;
          const f = nc.fc.features.find((x) => x.properties.role === role)!.properties;
          const src = nowcastSource(nc.run, (x) => fmtTime(x, tz));
          html = role === 'obs'
            ? `<b>Seen by satellite ${fmtTime(f.valid_t, tz)}</b><div>Fire edge observed by VIIRS and Sentinel-2 up to the last pass (${nc.observed?.label ?? ''}) · ${f.area_km2.toFixed(1)} km²</div>`
              + muted('Observed, not modelled. Updated at every new pass.')
            : role === 'now' || role === 'spot'
            ? `<b>Fire now (model estimate)</b><div>Estimate, not observed: modelled fire extent for ${fmtTime(f.valid_t, tz)}, P ≥ 50 %`
              + `${role === 'now' ? ` · ${f.area_km2.toFixed(1)} km²` : ''}</div>`
              + `<div>Dark inside: burned ground. Bright band: the active front along the estimated edge (${frontWidthM(f.area_km2) ? `${Math.round(frontWidthM(f.area_km2))} m: 20 % of the fire's radius, at most ${FRONT_WIDTH_M} m` : 'a small fire: edge line only'}).`
              + ` Parts under ${'0.3'} km² apart from the main fire are small marks.</div>`
              + `<div>${src}</div>` + muted(`Forecast issued ${fmtTime(nc.run.issuedAt, tz)}, advanced ${f.step} h.`)
            : `<b>Expected by ${fmtTime(f.valid_t, tz)} (${lookLabel(f.h)})</b>`
              + `<div>Forecast fire edge, P ≥ 50 % · ${f.area_km2.toFixed(1)} km²</div>`
              + muted(`Forecast issued ${fmtTime(nc.run.issuedAt, tz)} from ${nc.run.from}`);
        } else {
          const p = hit.properties as FireFront & { t: number };
          const when = `${fmtTime(p.t, tz)} local`;
          if (p.kind === 'forecast') {
            const issued = Date.parse(String(p.issued_at ?? p.model_run_at ?? p.valid_at));
            html = `<b>${p.forecast_set === 'initial' ? 'Initial forecast' : 'Forecast'} +${p.horizon_hours} h</b>`
              + `<div>Issued ${fmtTime(issued, tz)} from ${p.initialised_from ?? 'ignition point'}</div>`
              + `<div>Modelled fire extent, P ≥ ${Math.round((p.probability ?? 0.5) * 100)} %`
              + `${p.area_km2 != null ? ` · ${Number(p.area_km2).toFixed(1)} km²` : ''}</div>`
              + `<div>${p.t <= t ? 'Valid since' : 'Valid from'} ${when}</div>` + muted(p.source);
          } else {
            const what = { hotspots: 'Satellite hotspots', flame_front: 'Active flame front', burned_area: 'Burned area' }[p.observation_type ?? 'hotspots'];
            html = `<b>${what}</b><div>${p.instrument ?? ''} ${p.satellite ?? ''} · ${when}</div>`
              + (p.detections ? `<div>${p.detections} hotspot pixel${p.detections > 1 ? 's' : ''} · FRP ${Number(p.frp_mw ?? 0).toFixed(0)} MW</div>` : '')
              + (p.area_km2 != null ? `<div>Pixel footprint ${Number(p.area_km2).toFixed(1)} km²</div>` : '')
              + muted(`${p.source} · observed, ${fmtAge(t - p.t)} before the time shown`
                + (t - p.t > ACTIVE_FIRE_H * 3600000 ? ` · older than ${ACTIVE_FIRE_H} h: drawn as burned` : ` · within ${ACTIVE_FIRE_H} h: active fire`));
          }
        }
        popupRef.current?.remove();
        popupRef.current = new maplibregl.Popup({ className: 'ns-popup', closeButton: true, maxWidth: '320px' })
          .setLngLat(at).setHTML(html).addTo(map);
      });
      for (const id of CLICKABLE) {
        map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
      }
      // Hook for rehearsal and screenshot scripts (map.project, map.fire).
      (window as unknown as { __nsMap?: MLMap }).__nsMap = map;
      ready.current = true;
      applied.current.clear();
      queue.current?.dispose();
      queue.current = new SourceQueue(map);
      placeTags();
      (window as unknown as { __nsQueue?: SourceQueue }).__nsQueue = queue.current;
      sync();
      map.once('idle', () => {
        (window as unknown as { __nsFirstIdle?: number }).__nsFirstIdle = performance.now();   // for tests
        onFirstIdle?.();
      });
    });
    });
    return () => {
      cancelled = true; ready.current = false; popupRef.current?.remove();
      queue.current?.dispose(); queue.current = null;
      tagMarkers.current.forEach((m) => m.remove()); tagMarkers.current = [];
      vehicleMarkers.current.forEach((m) => m.remove()); vehicleMarkers.current.clear();
      created?.remove(); mapRef.current = null;
    };
    // The map is rebuilt only when another scenario is loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  useEffect(sync);

  // Closures recomputed (a forecast was loaded) or a live forecast added: reload those sources.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    queue.current?.set('streets', data.streets);
    sync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streetsVersion]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready.current || !fireVersion) return;
    queue.current?.set('fire', data.fire);
    sync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fireVersion]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    queue.current?.set('nowcast', nowcast?.fc ?? { type: 'FeatureCollection', features: [] });
    placeTags();
    sync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nowcastKey, layers.forecast]);

  // The clock came to rest: reload the tiles of our sources from the data the map already has and redraw the tags,
  // so no tile can stay on an older state after fast changes (a safety net: MapLibre 4.7 could leave tiles behind).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready.current || !settleKey) return;
    const caches = (map.style as unknown as { sourceCaches?: Record<string, { reload: () => void }> }).sourceCaches ?? {};
    for (const id of ['fire', 'nowcast', 'streets', 'callers', 'report-points', 'clusters']) caches[id]?.reload();
    placeTags();
    map.triggerRepaint();
    let done = false;
    const finish = () => { if (!done) { done = true; latestSettled.current?.(); } };
    const timer = setTimeout(finish, 1500);
    map.once('idle', finish);
    return () => { clearTimeout(timer); map.off('idle', finish); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settleKey]);

  // Operator-confirmed fires: the area (one in-flight update, latest wins) and a draggable label with a ✕ each.
  const fireMarkers = useRef(new Map<string, maplibregl.Marker>());
  const firesKey = operatorFires.map((f) => `${f.id}:${f.label}:${JSON.stringify(f.geometry.coordinates[0][0])}`).join('|');
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    queue.current?.set('operator-fires', { type: 'FeatureCollection',
      features: operatorFires.map((f) => ({ type: 'Feature', geometry: f.geometry, properties: { id: f.id } })) });
    for (const [id, m] of fireMarkers.current) if (!operatorFires.some((f) => f.id === id)) { m.remove(); fireMarkers.current.delete(id); }
    for (const f of operatorFires) {
      const at = centre(f.geometry);
      let m = fireMarkers.current.get(f.id);
      if (!m) {
        const el = document.createElement('div');
        el.className = 'ns-opfire';
        el.dataset.operatorFire = f.id;
        el.innerHTML = '<span class="ns-opfire-text"></span><button type="button" class="ns-opfire-del" aria-label="Delete this fire">✕</button>';
        el.querySelector('button')!.addEventListener('click', (ev) => { ev.stopPropagation(); handlers.current.onDeleteFire?.(f.id); });
        m = new maplibregl.Marker({ element: el, draggable: true, anchor: 'bottom' }).setLngLat(at).addTo(map);
        const marker = m;
        let from: [number, number] = at;
        m.on('dragstart', () => { const p = marker.getLngLat(); from = [p.lng, p.lat]; });
        m.on('dragend', () => { const p = marker.getLngLat(); handlers.current.onMoveFire?.(f.id, p.lng - from[0], p.lat - from[1]); });
        fireMarkers.current.set(f.id, m);
      }
      m.setLngLat(at);
      m.getElement().querySelector('.ns-opfire-text')!.textContent = f.label;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firesKey]);
  useEffect(() => () => { fireMarkers.current.forEach((m) => m.remove()); fireMarkers.current.clear(); }, [data]);
  const drawKey = drawing ? JSON.stringify([drawing, drawingShape]) : '';
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    const pts = drawing ?? [];
    const features: GeoJSON.Feature[] = pts.map((p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: p }, properties: {} }));
    // Exactly what Confirm adds: the drawn polygon or line strip, or the disc at the centre of the clicks.
    if (drawingShape) features.push({ type: 'Feature', geometry: drawingShape, properties: {} });
    queue.current?.set('draft', { type: 'FeatureCollection', features });
    map.getCanvas().style.cursor = drawing ? 'crosshair' : '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawKey]);

  // Bring a newly selected caller into view.
  useEffect(() => {
    const c = data.callers.find((x) => x.id === selectedId);
    if (c && mapRef.current) {
      mapRef.current.easeTo({ center: [c.place.lon, c.place.lat], zoom: Math.max(mapRef.current.getZoom(), 13.2),
        offset: [-insetRight / 2, -insetBottom / 2] });
    }
    // The insets are read when the selection changes; opening or closing the drawer does not move the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, data]);

  // A crew picked in the panel: go to it, clear of the phone drawer or side panel.
  useEffect(() => {
    if (focus && mapRef.current) {
      mapRef.current.easeTo({ center: [focus.lon, focus.lat], zoom: Math.max(mapRef.current.getZoom(), 12.8),
        offset: [-insetRight / 2, -insetBottom / 2] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.key]);

  // "Packaged basemap": a map control in the bottom-right corner, so it stacks above the scale bar and the attribution
  // instead of being placed over them.
  useEffect(() => {
    const map = packagedMap;
    if (!map) return;
    const el = document.createElement('div');
    el.className = 'maplibregl-ctrl pointer-events-none whitespace-nowrap rounded bg-ink-800/90 px-2 py-1 text-right text-[11px] text-ink-200';
    el.dataset.packagedBasemap = '';
    // Short on phones (one line, so the corner stays low); the full note on wider screens.
    el.innerHTML = 'Packaged basemap<span class="hidden md:inline"> (stored on this device, demo area only)</span>';
    const ctrl: maplibregl.IControl = { onAdd: () => el, onRemove: () => el.remove() };
    map.addControl(ctrl, 'bottom-right');
    return () => { try { map.removeControl(ctrl); } catch { /* the map was removed */ } };
  }, [packagedMap]);

  return (
    <>
      <div ref={container} className="h-full w-full" />
      <Legend mode={mode} nearby={layers.nearby} nowcast={nowcast} timeZone={data.entry.timezone ?? 'UTC'} />
    </>
  );
}

/** How many of the sorted `times` are at or before `t` (binary search). */
function countUpTo(times: number[], t: number): number {
  let lo = 0, hi = times.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Clock time only ("04:55"), in the scenario's time zone. */
const CLOCKS = new Map<string, Intl.DateTimeFormat>();
function clock(ms: number, timeZone: string): string {
  let f = CLOCKS.get(timeZone);
  if (!f) { f = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }); CLOCKS.set(timeZone, f); }
  return f.format(ms);
}

/** Tags of the three lines, one each at a different tip so they do not collide: "Seen by satellite 04:02" (north),
 * "Fire now (model estimate)" (south), "Expected by 04:55 (+1 h)" (east). Detailed also tags the other horizons. */
function nowcastTagPoints(nc: Nowcast | null, lookAhead: number, mode: MapMode, timeZone: string): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  const tips: Record<string, [string, (c: number[]) => number]> = {
    obs: ['n', (c) => c[1]], now: ['s', (c) => -c[1]], look: ['e', (c) => c[0]], other: ['w', (c) => -c[0]],
  };
  for (const f of nc?.fc.features ?? []) {
    const p = f.properties;
    if (p.role === 'spot') continue;
    const look = p.role === `h${lookAhead}`;
    if (p.role.startsWith('h') && !look && mode === 'simple') continue;
    const kind = p.role === 'obs' ? 'obs' : p.role === 'now' ? 'now' : look ? 'look' : 'other';
    const rings = f.geometry.type === 'Polygon' ? [f.geometry.coordinates[0]]
      : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates.map((poly) => poly[0]) : [];
    const pts = rings.flat();
    if (!pts.length) continue;
    const [side, score] = tips[kind];
    const text = kind === 'obs' ? `Seen by satellite ${clock(p.valid_t, timeZone)}` : kind === 'now' ? 'Fire now (model estimate)'
      : kind === 'look' ? `Expected by ${clock(p.valid_t, timeZone)} (${lookLabel(p.h)})` : lookLabel(p.h);
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: pts.reduce((a, b) => (score(b) > score(a) ? b : a)) },
      properties: { role: kind, horizon_hours: p.h, text, side, run_id: p.run_id } });
  }
  return { type: 'FeatureCollection', features };
}

/** A line sample for the legend: solid, dashed or a halo, in the given colour. */
function LineKey({ colour, dashed, dotted, halo, casing }: { colour: string; dashed?: boolean; dotted?: boolean; halo?: boolean; casing?: string }) {
  return (
    <svg width="26" height="10" aria-hidden="true" className="shrink-0">
      {casing && <line x1="2" y1="5" x2="24" y2="5" stroke={casing} strokeWidth="7" strokeLinecap="round" />}
      <line x1="2" y1="5" x2="24" y2="5" stroke={colour} strokeWidth={halo ? 8 : 3} strokeOpacity={halo ? 0.7 : 1}
        strokeDasharray={dashed ? '4 3' : dotted ? '0.1 4' : undefined} strokeLinecap={dashed ? 'butt' : 'round'} />
    </svg>
  );
}

function DotKey({ fill, ring, thin }: { fill: string; ring?: string; thin?: boolean }) {
  return (
    <svg width="26" height="14" aria-hidden="true" className="shrink-0">
      <circle cx="13" cy="7" r="5" fill={fill} stroke={ring ?? '#07090d'} strokeWidth={thin ? 1.2 : ring ? 2.5 : 1.5} />
    </svg>
  );
}

function AreaKey({ fill, opacity, edge }: { fill: string; opacity: number; edge?: string }) {
  return (
    <svg width="26" height="12" aria-hidden="true" className="shrink-0">
      <rect x="3" y="1" width="20" height="10" fill={fill} fillOpacity={opacity} stroke={edge ?? fill}
        strokeOpacity={edge ? 0.95 : 0.6} strokeWidth={edge ? 1.2 : 1} />
    </svg>
  );
}

/** Small legend under the zoom buttons; starts as a "Legend" button so it never hides callers. */
function Legend({ mode, nearby, nowcast, timeZone }: { mode: MapMode; nearby: boolean; nowcast: Nowcast | null; timeZone: string }) {
  const [open, setOpen] = useState(false);
  const simple = mode === 'simple';
  const row = (key: React.ReactNode, text: string) => (
    <div className="flex items-center gap-1.5 whitespace-nowrap">{key}<span>{text}</span></div>
  );
  return (
    <div className="ns-legend" data-legend={open ? 'open' : 'closed'}>
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-1 font-bold">
        Legend <span className="ml-auto text-ink-400">{open ? '✕' : '▸'}</span>
      </button>
      {open && (
        <div className="mt-1 space-y-0.5">
          {row(<LineKey colour={STATUS_COLOUR.open} />, 'Open road')}
          {row(<LineKey colour={STATUS_COLOUR.blocked} />, 'Closed: fire seen by satellite')}
          {row(<LineKey colour={FORECAST_CLOSURE_COLOUR} dashed />, 'Forecast closure (not seen yet)')}
          {!simple && nearby && row(<LineKey colour="#fbbf24" halo />, 'Fire nearby (satellite, 1 km pixel)')}
          {row(<LineKey colour="#22d3ee" casing="#083344" />, 'Crew route')}
          {row(<LineKey colour="#fbbf24" dashed casing="#083344" />, 'Route cut')}
          <div className="pt-0.5" />
          <div className="pt-0.5 text-[10px] font-bold uppercase tracking-wider text-ink-400">Observed</div>
          {row(<LineKey colour={OBSERVED_COLOUR} />, `Seen by satellite${nowcast?.observed ? ` ${fmtTime(nowcast.observed.at, timeZone)}` : ''} (VIIRS + Sentinel-2)`)}
          <div className="pt-0.5 text-[10px] font-bold uppercase tracking-wider text-ink-400">Model estimate, not observed</div>
          {row(<LineKey colour={FRONT_COLOUR} halo />, 'Fire now (model estimate): active front')}
          {row(<AreaKey fill={NOWCAST_COLOUR} opacity={0.9} edge="#6b4a3e" />, 'Burned (estimate, inside the front)')}
          {row(<DotKey fill={FRONT_COLOUR} ring={FRONT_EDGE} thin />, `Small separate part (< 0.3 km²)`)}
          {nowcast && (
            <div className="whitespace-normal pl-8 text-[10px] leading-tight text-ink-400" data-legend-nowcast>
              {nowcastSource(nowcast.run, (x) => fmtTime(x, timeZone))}
            </div>
          )}
          <div className="pt-0.5 text-[10px] font-bold uppercase tracking-wider text-ink-400">Forecast</div>
          {row(<LineKey colour={LOOK_COLOUR} dashed />, 'Expected fire edge (Look ahead)')}
          {!simple && row(<LineKey colour={ZONE_COLOUR.h2} />, 'Other horizons (+6 h dotted)')}
          <div className="pt-0.5" />
          {!simple && row(<LineKey colour={INITIAL_FORECAST_COLOUR} />, 'Initial forecast (at ignition)')}
          {simple ? row(<AreaKey fill={SIMPLE_FIRE_COLOUR} opacity={0.35} />, `Fire seen by the latest VIIRS pass (last ${SIMPLE_FIRE_H} h)`)
            : <>
              {row(<AreaKey fill="#ef4444" opacity={0.45} />, `VIIRS 375 m (last ${ACTIVE_FIRE_H} h)`)}
              {row(<AreaKey fill="#a855f7" opacity={0.3} />, 'MODIS 1 km')}
              {row(<AreaKey fill="#14b8a6" opacity={0.3} />, 'SLSTR 1 km')}
              {row(<AreaKey fill={ACTIVE_FIRE_COLOUR} opacity={0.9} />, 'Flame front (Sentinel-2)')}
            </>}
          {!simple && row(<AreaKey fill={OLD_FIRE_COLOUR} opacity={0.6} />, `Burned / older detections (> ${ACTIVE_FIRE_H} h)`)}
          <div className="pt-0.5" />
          {row(<DotKey fill={URGENCY_COLOUR.life_threat} ring="#ffffff" thin />, 'Caller: life threat')}
          {row(<DotKey fill={URGENCY_COLOUR.urgent} ring="#ffffff" thin />, 'Caller: urgent')}
          {row(<DotKey fill={URGENCY_COLOUR.routine} ring="#ffffff" thin />, 'Caller: routine')}
          {row(<DotKey fill="#8a9bb3" ring={STAGE_COLOUR.dispatched} />, 'Crew dispatched (ring)')}
          {row(<DotKey fill="#0e7490" ring="#a5f3fc" />, 'Fire station / gendarmerie')}
        </div>
      )}
    </div>
  );
}
