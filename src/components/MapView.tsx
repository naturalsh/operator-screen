import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { type ExpressionSpecification, type GeoJSONSource, type Map as MLMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  STAGE_COLOUR, STAGE_LABEL, STATUS_COLOUR, STATUS_SHORT, URGENCY_COLOUR, URGENCY_LABEL, URGENCY_ORDER,
  HORIZON_COLOURS, INITIAL_FORECAST_COLOUR, aheadContours, closureAt, closureSource, currentForecast, fireNearby, forecastOnly, forecastReach,
  modelLabel, fmtAge, fmtTime, statusAt, streetLabel, visibleCallers,
} from '../data';
import { resolveBasemap } from '../basemap';
import { CREW_STATUS_COLOUR, type CrewStatus } from '../crews';
import type { CallerReport, FireFront, ScenarioData, Stage, StreetAccess, Urgency } from '../types';

/** A crew vehicle that is away from its station. */
export interface Vehicle { id: string; name: string; status: CrewStatus; position: [number, number]; label: string }

export type LayerKey = 'forecast' | 'initial' | 'observed' | 'streets' | 'nearby' | 'callers' | 'crews';

/** Simple: what a newcomer needs to read the screen. Detailed: every source and distinction. */
export type MapMode = 'simple' | 'detailed';

/** Layers that only exist in Detailed mode. */
const DETAILED_ONLY = ['initial-pending', 'initial-reached', 'initial-label', 'streets-nearby', 'burned-area',
  'forecast-pending', 'forecast-reached', 'forecast-label'];
/** Layers that only exist in Simple mode: the forecast drawn as an area instead of lines. */
const SIMPLE_ONLY = ['forecast-fill', 'forecast-fill-edge', 'forecast-outline', 'forecast-tag'];
/** Simple-mode forecast: an orange area with a thin white edge, unlike any road colour. */
export const FORECAST_FILL_COLOUR = '#f97316';
/** Streets closed by the forecast only: orange, dashed; observed closures are solid red. */
export const FORECAST_CLOSURE_COLOUR = '#fb923c';

/** Satellite detections in Simple mode: one colour for every sensor. */
const SIMPLE_FIRE_COLOUR = '#fb7185';
/** Radius around the selected caller and the active routes in which "fire nearby" is drawn. */
const NEARBY_RADIUS_M = 1000;

const LAYER_GROUPS: Record<LayerKey, string[]> = {
  forecast: ['forecast-pending', 'forecast-reached', 'forecast-label',
    'forecast-fill', 'forecast-fill-edge', 'forecast-outline', 'forecast-tag'],
  initial: ['initial-pending', 'initial-reached', 'initial-label'],
  observed: ['hotspots', 'burned-area', 'flame-front'],
  streets: ['streets-near', 'streets', 'streets-forecast'],
  nearby: ['streets-nearby'],
  callers: ['callers-selected', 'callers', 'callers-label'],
  crews: ['routes-casing', 'routes', 'routes-cut', 'responders', 'responders-label'],
};

const HORIZON_COLOUR = ['match', ['get', 'rank'], 0, HORIZON_COLOURS[0], 1, HORIZON_COLOURS[1], HORIZON_COLOURS[2]] as unknown as string;
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
          rank: URGENCY_ORDER[urgency], label: c.people_at_risk > 0 ? `${c.people_at_risk} at risk` : '' },
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
}

export function MapView({ data, now, layers, selectedId, nearIds, stages, routes, urgencyOf, onSelect, vehicles = [], focus = null, mode = 'simple',
  insetBottom = 0, insetRight = 0, fitFire = false }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const ready = useRef(false);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const [offline, setOffline] = useState(false);
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
  const latest = useRef({ now, layers, selectedId, nearIds, data, stages, routes, urgencyOf, vehicles, mode, nearbyIds });
  latest.current = { now, layers, selectedId, nearIds, data, stages, routes, urgencyOf, vehicles, mode, nearbyIds };
  const vehicleMarkers = useRef(new Map<string, maplibregl.Marker>());

  /** Push the current time, selection and toggles into the map. */
  const sync = () => {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    const { now: t, layers: on, selectedId: sel, nearIds: near, data: d, stages: st, routes: rts, urgencyOf: uo } = latest.current;
    const upTo: ExpressionSpecification = ['<=', ['get', 't'], t];
    const kind = (k: string): ExpressionSpecification => ['==', ['get', 'kind'], k];
    const obs = (o: string): ExpressionSpecification => ['==', ['get', 'observation_type'], o];
    // The forecast in force: the latest update issued by now (dashed until each horizon is reached).
    const cur = currentForecast(d.fire.features.map((f) => f.properties), t);
    const inForce: ExpressionSpecification = ['all', kind('forecast'), ['==', ['get', 'set'], cur?.set ?? 'none'],
      ['==', ['get', 'issue_t'], cur?.issuedAt ?? -1]];
    map.setFilter('forecast-reached', ['all', inForce, upTo]);
    map.setFilter('forecast-label', inForce);
    map.setFilter('forecast-pending', ['all', inForce, ['>', ['get', 't'], t]]);
    // Simple: only the next horizon not reached yet is a filled area (the last one once all are reached);
    // the other horizons of the same forecast are thin, faint outlines. Each carries a "+4 h" tag.
    const next = cur?.contours.find((p) => p.t > t) ?? cur?.contours[cur.contours.length - 1];
    const isNext: ExpressionSpecification = ['==', ['get', 'id'], next?.id ?? ''];
    map.setFilter('forecast-fill', ['all', inForce, isNext]);
    map.setFilter('forecast-fill-edge', ['all', inForce, isNext]);
    map.setFilter('forecast-outline', ['all', inForce, ['!', isNext]]);
    map.setFilter('forecast-tag', inForce);
    // Optional: the single forecast made at ignition, for comparison (only when updates exist).
    const initial: ExpressionSpecification = ['all', kind('forecast'), ['==', ['get', 'set'], cur?.set === 'update' ? 'initial' : 'none']];
    map.setFilter('initial-reached', ['all', initial, upTo]);
    map.setFilter('initial-label', ['all', initial, upTo]);
    map.setFilter('initial-pending', ['all', initial, ['>', ['get', 't'], t]]);
    map.setFilter('hotspots', ['all', obs('hotspots'), upTo]);
    map.setFilter('flame-front', ['all', obs('flame_front'), upTo]);
    map.setFilter('burned-area', ['all', obs('burned_area'), upTo]);
    map.setFilter('streets-near', ['in', ['get', 'id'], ['literal', near]]);
    // Blocked by a satellite detection only (the model has not reached the street yet): dashed red.
    // Closed by the forecast only (no satellite detection yet): a forecast closure, orange dashed in both modes.
    const forecastOnlyExpr: ExpressionSpecification = ['all', ['<=', ['coalesce', ['get', 'tm'], 9e15], t], ['>', ['coalesce', ['get', 'ts'], 9e15], t]];
    const simple = latest.current.mode === 'simple';
    map.setFilter('streets-forecast', forecastOnlyExpr);
    map.setFilter('streets', ['!', forecastOnlyExpr]);
    map.setPaintProperty('hotspots', 'fill-color', simple ? SIMPLE_FIRE_COLOUR : INSTRUMENT_COLOUR);
    // Every overpass adds its pixels, so overlaps build up: keep each layer of pixels very light in Simple.
    map.setPaintProperty('hotspots', 'fill-opacity', simple ? 0.06 : ['match', ['get', 'instrument'], 'VIIRS', 0.3, 0.1]);
    // The forecast is the main fire line in Simple: draw the not-yet-reached part clearly too.
    map.setPaintProperty('forecast-pending', 'line-width', simple ? 2.2 : 1.4);
    map.setPaintProperty('forecast-pending', 'line-opacity', simple ? 0.95 : 0.55);
    map.setPaintProperty('forecast-reached', 'line-width', simple ? 4 : 3.5);
    map.setPaintProperty('hotspots', 'fill-outline-color', simple ? 'rgba(0,0,0,0)' : INSTRUMENT_COLOUR);
    map.setPaintProperty('flame-front', 'fill-color', simple ? SIMPLE_FIRE_COLOUR : '#fde047');
    map.setPaintProperty('flame-front', 'fill-opacity', simple ? 0.6 : 0.95);
    // Fire nearby: a coarse pixel covers the street and neither source has closed it yet. (Not `t > now`:
    // a street that is never closed has t = scenario start.)
    map.setFilter('streets-nearby', ['all', ['<=', ['coalesce', ['get', 'tn'], 9e15], t],
      ['>', ['coalesce', ['get', 'tm'], 9e15], t], ['>', ['coalesce', ['get', 'ts'], 9e15], t],
      ['in', ['get', 'id'], ['literal', latest.current.nearbyIds]]]);
    // Streets the fire has not come near yet (no forecast in force so far within 3 km; mostly the town of
    // Marmaris) are barely visible. Routes and the highlight around a selected caller are separate layers.
    map.setPaintProperty('streets', 'line-opacity', ['case', ['<=', ['coalesce', ['get', 'tnear'], 9e15], t], 1, 0.07]);
    map.setPaintProperty('streets', 'line-color', ['match',
      ['case', ['<=', ['get', 't'], t], ['get', 'status'], ['get', 'before']],
      'open', STATUS_COLOUR.open, 'special_access', STATUS_COLOUR.special_access, STATUS_COLOUR.blocked]);
    map.setFilter('callers-selected', ['==', ['get', 'id'], sel ?? '']);
    (map.getSource('callers') as GeoJSONSource).setData(
      callersFc(visibleCallers(d.callers, t), st, uo));
    const ok = rts.filter((r) => !r.cut).flatMap((r) => r.edgeIds);
    const cut = rts.filter((r) => r.cut).flatMap((r) => r.edgeIds);
    map.setFilter('routes-casing', ['in', ['get', 'id'], ['literal', [...ok, ...cut]]]);
    map.setFilter('routes', ['in', ['get', 'id'], ['literal', ok]]);
    map.setFilter('routes-cut', ['in', ['get', 'id'], ['literal', cut]]);
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
    for (const [key, ids] of Object.entries(LAYER_GROUPS) as [LayerKey, string[]][]) {
      for (const id of ids) {
        const shownHere = on[key] && !(simple ? DETAILED_ONLY.includes(id) : SIMPLE_ONLY.includes(id));
        map.setLayoutProperty(id, 'visibility', shownHere ? 'visible' : 'none');
      }
    }
  };

  useEffect(() => {
    let cancelled = false;
    let created: MLMap | null = null;
    resolveBasemap().then((basemap) => {
    if (cancelled) return;
    setOffline(basemap.offline);
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
    if (fitFire) {
      // Bounding box of the forecast contours, so a narrow screen starts on the fire.
      const box = new maplibregl.LngLatBounds();
      const add = (c: unknown): void => {
        if (Array.isArray(c) && typeof c[0] === 'number') box.extend(c as [number, number]);
        else if (Array.isArray(c)) c.forEach(add);
      };
      // Only the forecast in force at the time shown (later forecasts are not known yet).
      const cur = currentForecast(data.fire.features.map((f) => f.properties), latest.current.now);
      const ids = new Set(cur?.contours.map((c) => c.id) ?? []);
      for (const f of data.fire.features) if (ids.has(f.properties.id) && 'coordinates' in f.geometry) add(f.geometry.coordinates);
      if (box.isEmpty() && data.fireMeta.ignition) box.extend([data.fireMeta.ignition.lon, data.fireMeta.ignition.lat]);
      if (!box.isEmpty()) map.fitBounds(box, { padding: { top: 24, left: 24, right: 24 + insetRight, bottom: 24 + insetBottom }, animate: false });
    }
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

    map.on('load', () => {
      map.addSource('fire', { type: 'geojson', data: data.fire });
      map.addSource('forecast-tags', { type: 'geojson', data: forecastTagPoints(data) });
      map.addSource('streets', { type: 'geojson', data: data.streets });
      map.addSource('callers', { type: 'geojson', data: callersFc([], {}, (c) => c.urgency) });
      map.addSource('responders', { type: 'geojson', data: {
        type: 'FeatureCollection',
        features: data.responders.map((r) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.place.lon, r.place.lat] },
          properties: { id: r.id, name: r.name, kind: r.kind } })),
      } });

      map.addLayer({ id: 'hotspots', type: 'fill', source: 'fire',
        paint: { 'fill-color': INSTRUMENT_COLOUR, 'fill-opacity': ['match', ['get', 'instrument'], 'VIIRS', 0.3, 0.1] } });
      map.addLayer({ id: 'burned-area', type: 'line', source: 'fire',
        paint: { 'line-color': '#ffffff', 'line-width': 1.5, 'line-opacity': 0.8 } });
      map.addLayer({ id: 'flame-front', type: 'fill', source: 'fire',
        paint: { 'fill-color': '#fde047', 'fill-opacity': 0.95, 'fill-outline-color': '#fef08a' } });

      // Simple-mode forecast area: under the streets, so roads stay readable on top of it.
      map.addLayer({ id: 'forecast-fill', type: 'fill', source: 'fire',
        paint: { 'fill-color': FORECAST_FILL_COLOUR, 'fill-opacity': 0.28 } });

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
      map.addLayer({ id: 'forecast-pending', type: 'line', source: 'fire',
        paint: { 'line-color': HORIZON_COLOUR, 'line-width': 1.4, 'line-dasharray': [3, 3], 'line-opacity': 0.55 } });
      map.addLayer({ id: 'forecast-reached', type: 'line', source: 'fire',
        paint: { 'line-color': HORIZON_COLOUR, 'line-width': 3.5 } });
      map.addLayer({ id: 'forecast-label', type: 'symbol', source: 'fire',
        layout: { 'symbol-placement': 'line', 'text-field': ['concat', 'forecast +', ['to-string', ['get', 'horizon_hours']], ' h'],
          'text-font': ['Noto Sans Regular'], 'text-size': 11, 'symbol-spacing': 400 },
        paint: { 'text-color': '#fde68a', 'text-halo-color': '#07090d', 'text-halo-width': 1.5 } });
      map.addLayer({ id: 'forecast-outline', type: 'line', source: 'fire',
        paint: { 'line-color': '#fdba74', 'line-width': 1, 'line-opacity': 0.45 } });
      map.addLayer({ id: 'forecast-fill-edge', type: 'line', source: 'fire',
        paint: { 'line-color': '#ffffff', 'line-width': 1.4, 'line-opacity': 0.9 } });
      // Two tags per horizon at most, at two tips of its contour (see forecastTagPoints).
      map.addLayer({ id: 'forecast-tag', type: 'symbol', source: 'forecast-tags',
        layout: { 'text-field': ['concat', '+', ['to-string', ['get', 'horizon_hours']], ' h'],
          'text-font': ['Noto Sans Regular'], 'text-size': 11,
          // Just outside the contour, on the side the tip faces.
          'text-anchor': ['match', ['get', 'side'], 'n', 'bottom', 's', 'top', 'e', 'left', 'w', 'right', 'ne', 'bottom-left', 'top-right'],
          'text-offset': ['match', ['get', 'side'], 'n', ['literal', [0, -0.2]], 's', ['literal', [0, 0.2]], 'e', ['literal', [0.3, 0]],
            'w', ['literal', [-0.3, 0]], 'ne', ['literal', [0.2, -0.2]], ['literal', [-0.2, 0.2]]],
          'text-allow-overlap': false, 'text-padding': 2, 'symbol-sort-key': ['get', 'horizon_hours'] },
        paint: { 'text-color': '#ffffff', 'text-halo-color': '#7c2d12', 'text-halo-width': 1.6 } });

      map.addLayer({ id: 'responders', type: 'circle', source: 'responders',
        paint: { 'circle-radius': 8, 'circle-color': '#0e7490', 'circle-stroke-color': '#a5f3fc', 'circle-stroke-width': 2.5 } });
      map.addLayer({ id: 'responders-label', type: 'symbol', source: 'responders',
        layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11,
          'text-offset': [0, -1.4], 'text-anchor': 'bottom', 'text-allow-overlap': false, 'text-padding': 4 },
        paint: { 'text-color': '#a5f3fc', 'text-halo-color': '#07090d', 'text-halo-width': 1.5 } });

      map.addLayer({ id: 'callers-selected', type: 'circle', source: 'callers',
        paint: { 'circle-radius': 17, 'circle-color': 'rgba(255,255,255,0.15)', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 } });
      map.addLayer({ id: 'callers', type: 'circle', source: 'callers',
        paint: { 'circle-radius': ['match', ['get', 'urgency'], 'life_threat', 9, 'urgent', 7.5, 6],
          'circle-color': ['get', 'colour'],
          'circle-stroke-color': ['match', ['get', 'stage'], 'new', '#07090d', ['get', 'ring']],
          'circle-stroke-width': ['match', ['get', 'stage'], 'new', 2, 'taken', 2.5, 3.5] } });
      map.addLayer({ id: 'callers-label', type: 'symbol', source: 'callers',
        // Labels that would collide are hidden (most urgent kept); they appear when zooming in.
        layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 11,
          'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-allow-overlap': false, 'text-ignore-placement': false,
          'text-padding': 4, 'symbol-sort-key': ['get', 'rank'] },
        paint: { 'text-color': '#f2f6fb', 'text-halo-color': '#07090d', 'text-halo-width': 1.5 } });

      const ign = data.fireMeta.ignition;
      if (ign) {
        const el = document.createElement('div');
        el.textContent = '★';
        el.title = ign.label ?? 'Ignition';
        el.style.cssText = 'font-size:22px;color:#fff;text-shadow:0 0 4px #000;line-height:1';
        new maplibregl.Marker({ element: el }).setLngLat([ign.lon, ign.lat]).addTo(map);
      }

      // One click handler, most specific feature first: caller, response point, street, fire front.
      const CLICKABLE = ['callers', 'responders', 'streets', 'streets-forecast', 'flame-front', 'forecast-reached', 'forecast-pending',
        'initial-reached', 'initial-pending', 'hotspots', 'burned-area'];
      const muted = (text: string) => `<div class="ns-muted">${text}</div>`;
      const tag = (p: { synthetic?: boolean; basis?: string }) => (p.synthetic ? '<span class="synthetic-tag">SYNTHETIC</span>'
        : p.basis === 'fire_model' ? '<span class="model-tag">MODEL OUTPUT</span>'
          : p.basis === 'satellite' ? '<span class="model-tag">SATELLITE</span>'
            : p.basis === 'fire_model_and_satellite' ? `<span class="model-tag">${modelLabel(latest.current.data.streetsMeta)}</span>` : '');
      map.on('click', (e) => {
        const hit = map.queryRenderedFeatures(e.point, { layers: CLICKABLE.filter((id) => map.getLayer(id)) })
          .sort((a, b) => CLICKABLE.indexOf(a.layer.id) - CLICKABLE.indexOf(b.layer.id))[0];
        if (!hit) return;
        const { now: t, data: d, stages: st, urgencyOf: uo } = latest.current;
        const tz = d.entry.timezone ?? 'UTC';
        let html = '';
        let at: [number, number] = [e.lngLat.lng, e.lngLat.lat];
        if (hit.layer.id === 'callers') {
          const c = d.callers.find((x) => x.id === hit.properties.id);
          if (!c) return;
          onSelect(c.id);
          at = [c.place.lon, c.place.lat];
          const u = uo(c);
          html = `<b>${c.place.label ?? 'Caller'}</b>`
            + `<div><span style="color:${URGENCY_COLOUR[u]}">●</span> ${URGENCY_LABEL[u]} · ${STAGE_LABEL[st[c.id] ?? 'new']}`
            + `${c.people_at_risk > 0 ? ` · ${c.people_at_risk} at risk` : ''}</div>`
            + `<div>${c.summary_en ?? c.summary}</div>`
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
              const feature = d.streets.features.find((f) => f.properties.id === p.id);
              const reach = feature ? forecastReach(feature, aheadContours(d.fire.features, t)) : null;
              return reach ? `<div>Forecast (issued ${fmtTime(reach.issuedAt, tz)}): fire may reach this street by `
                + `${fmtTime(reach.at, tz)} (+${reach.horizon} h)</div>` : '';
            })()
            + (fireNearby(p, t) ? `<div style="color:#fbbf24">⚠ Fire nearby (satellite): ${p.fire_nearby_source ?? '1 km pixel'} `
              + `since ${fmtTime(p.tn!, tz)}. 1 km pixel, too coarse to close the street.</div>` : '')
            + (closure && (p.tm ?? 9e15) <= t && p.model_reason ? muted(p.model_reason) : '')
            + (closure && (p.ts ?? 9e15) <= t && (p.satellite_reason ?? p.reason) ? muted(p.satellite_reason ?? p.reason ?? '') : '')
            + (p.imagery_date ? muted(`Imagery: ${p.imagery_date}`) : '')
            + muted(p.confirmed_by_operator ? 'Confirmed by operator' : 'Not confirmed by an operator') + tag(p);
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
              + muted(`${p.source} · observed, ${fmtAge(t - p.t)} before the time shown`);
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
      sync();
    });
    });
    return () => {
      cancelled = true; ready.current = false; popupRef.current?.remove();
      vehicleMarkers.current.forEach((m) => m.remove()); vehicleMarkers.current.clear();
      created?.remove(); mapRef.current = null;
    };
    // The map is rebuilt only when another scenario is loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  useEffect(sync);

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

  return (
    <>
      <div ref={container} className="h-full w-full" />
      <Legend mode={mode} nearby={layers.nearby} />
      {offline && (
        <span className="absolute left-2 top-2 rounded bg-ink-800/90 px-2 py-1 text-[11px] text-ink-200">
          Offline basemap (packaged copy, demo area only)
        </span>
      )}
    </>
  );
}

/** Label points of the forecast contours: two tips of each contour, on different sides for each horizon
 * (first: north and south, second: east and west, third: north-east and south-west) so nested contours do
 * not put their tags on top of each other. Points carry the contour's properties for the same filter. */
function forecastTagPoints(data: ScenarioData): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const f of data.fire.features) {
    const p = f.properties;
    if (p.kind !== 'forecast') continue;
    const rings = f.geometry.type === 'Polygon' ? [f.geometry.coordinates[0]]
      : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates.map((poly) => poly[0]) : [];
    const pts = rings.flat();
    if (!pts.length) continue;
    const tip = (score: (c: number[]) => number) => pts.reduce((a, b) => (score(b) > score(a) ? b : a));
    const sides: [string, (c: number[]) => number][][] = [
      [['n', (c) => c[1]], ['s', (c) => -c[1]]],
      [['e', (c) => c[0]], ['w', (c) => -c[0]]],
      [['ne', (c) => c[0] + c[1]], ['sw', (c) => -c[0] - c[1]]],
    ];
    const props = { id: p.id, kind: p.kind, set: p.set, issue_t: p.issue_t, horizon_hours: p.horizon_hours, t: p.t };
    for (const [side, score] of sides[Math.min(p.rank ?? 0, 2)]) {
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: tip(score) }, properties: { ...props, side } });
    }
  }
  return { type: 'FeatureCollection', features };
}

/** A line sample for the legend: solid, dashed or a halo, in the given colour. */
function LineKey({ colour, dashed, halo, casing }: { colour: string; dashed?: boolean; halo?: boolean; casing?: string }) {
  return (
    <svg width="26" height="10" aria-hidden="true" className="shrink-0">
      {casing && <line x1="2" y1="5" x2="24" y2="5" stroke={casing} strokeWidth="7" strokeLinecap="round" />}
      <line x1="2" y1="5" x2="24" y2="5" stroke={colour} strokeWidth={halo ? 8 : 3} strokeOpacity={halo ? 0.7 : 1}
        strokeDasharray={dashed ? '4 3' : undefined} strokeLinecap={dashed ? 'butt' : 'round'} />
    </svg>
  );
}

function DotKey({ fill, ring }: { fill: string; ring?: string }) {
  return (
    <svg width="26" height="14" aria-hidden="true" className="shrink-0">
      <circle cx="13" cy="7" r="5" fill={fill} stroke={ring ?? '#07090d'} strokeWidth={ring ? 2.5 : 1.5} />
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
function Legend({ mode, nearby }: { mode: MapMode; nearby: boolean }) {
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
          {simple ? <>
            {row(<AreaKey fill={FORECAST_FILL_COLOUR} opacity={0.4} edge="#ffffff" />, 'Fire forecast, next horizon')}
            {row(<LineKey colour="#fdba74" />, 'Later horizons (+8 / +12 h)')}
          </> : <>
            {row(<LineKey colour={HORIZON_COLOURS[0]} />, 'Fire forecast (+4 / +8 / +12 h)')}
            {row(<LineKey colour={HORIZON_COLOURS[0]} dashed />, 'Forecast, time not reached yet')}
          </>}
          {!simple && row(<LineKey colour={INITIAL_FORECAST_COLOUR} />, 'Initial forecast (at ignition)')}
          {simple ? row(<AreaKey fill={SIMPLE_FIRE_COLOUR} opacity={0.35} />, 'Fire seen by satellite')
            : <>
              {row(<AreaKey fill="#ef4444" opacity={0.45} />, 'VIIRS 375 m')}
              {row(<AreaKey fill="#a855f7" opacity={0.3} />, 'MODIS 1 km')}
              {row(<AreaKey fill="#14b8a6" opacity={0.3} />, 'SLSTR 1 km')}
              {row(<AreaKey fill="#fde047" opacity={0.9} />, 'Flame front (Sentinel-2)')}
            </>}
          <div className="pt-0.5" />
          {row(<DotKey fill={URGENCY_COLOUR.life_threat} />, 'Caller: life threat')}
          {row(<DotKey fill={URGENCY_COLOUR.urgent} />, 'Caller: urgent')}
          {row(<DotKey fill={URGENCY_COLOUR.routine} />, 'Caller: routine')}
          {row(<DotKey fill="#8a9bb3" ring={STAGE_COLOUR.dispatched} />, 'Crew dispatched (ring)')}
          {row(<DotKey fill="#0e7490" ring="#a5f3fc" />, 'Fire station / gendarmerie')}
        </div>
      )}
    </div>
  );
}
