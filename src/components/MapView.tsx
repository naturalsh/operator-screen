import { useEffect, useRef, useState } from 'react';
import maplibregl, { type ExpressionSpecification, type GeoJSONSource, type Map as MLMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { STAGE_COLOUR, STAGE_LABEL, STATUS_COLOUR, STATUS_SHORT, URGENCY_COLOUR, fmtTime, statusAt, streetLabel, visibleCallers } from '../data';
import { resolveBasemap } from '../basemap';
import type { CallerReport, ScenarioData, Stage, StreetAccess, Urgency } from '../types';

export type LayerKey = 'forecast' | 'observed' | 'streets' | 'callers' | 'crews';

const LAYER_GROUPS: Record<LayerKey, string[]> = {
  forecast: ['forecast-pending', 'forecast-reached', 'forecast-label'],
  observed: ['hotspots', 'burned-area', 'flame-front'],
  streets: ['streets-near', 'streets'],
  callers: ['callers-selected', 'callers', 'callers-label'],
  crews: ['routes-casing', 'routes', 'routes-cut', 'responders', 'responders-label'],
};

const HORIZON_COLOUR = ['match', ['get', 'horizon_hours'], 8, '#fde047', 20, '#fb923c', '#f97316'] as unknown as string;
const INSTRUMENT_COLOUR = ['match', ['get', 'instrument'], 'MODIS', '#a855f7', 'SLSTR', '#14b8a6', '#ef4444'] as unknown as string;

function callersFc(callers: CallerReport[], synthetic: boolean, stages: Record<string, Stage>,
  urgencyOf: (c: CallerReport) => Urgency): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: callers.map((c) => {
      const stage = stages[c.id] ?? 'new';
      const urgency = urgencyOf(c);
      // Short map label (the list carries the place): the operator's stage once it is not new, people at risk.
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [c.place.lon, c.place.lat] },
        properties: { id: c.id, urgency, colour: URGENCY_COLOUR[urgency], stage, ring: STAGE_COLOUR[stage],
          label: [stage === 'new' ? '' : STAGE_LABEL[stage], c.people_at_risk > 0 ? `${c.people_at_risk} at risk` : '',
            synthetic ? '(synthetic)' : ''].filter(Boolean).join(' · ') },
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
}

export function MapView({ data, now, layers, selectedId, nearIds, stages, routes, urgencyOf, onSelect }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const ready = useRef(false);
  const [offline, setOffline] = useState(false);
  const latest = useRef({ now, layers, selectedId, nearIds, data, stages, routes, urgencyOf });
  latest.current = { now, layers, selectedId, nearIds, data, stages, routes, urgencyOf };

  /** Push the current time, selection and toggles into the map. */
  const sync = () => {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    const { now: t, layers: on, selectedId: sel, nearIds: near, data: d, stages: st, routes: rts, urgencyOf: uo } = latest.current;
    const upTo: ExpressionSpecification = ['<=', ['get', 't'], t];
    const kind = (k: string): ExpressionSpecification => ['==', ['get', 'kind'], k];
    const obs = (o: string): ExpressionSpecification => ['==', ['get', 'observation_type'], o];
    map.setFilter('forecast-reached', ['all', kind('forecast'), upTo]);
    map.setFilter('forecast-label', ['all', kind('forecast'), upTo]);
    map.setFilter('forecast-pending', ['all', kind('forecast'), ['>', ['get', 't'], t]]);
    map.setFilter('hotspots', ['all', obs('hotspots'), upTo]);
    map.setFilter('flame-front', ['all', obs('flame_front'), upTo]);
    map.setFilter('burned-area', ['all', obs('burned_area'), upTo]);
    map.setFilter('streets-near', ['in', ['get', 'id'], ['literal', near]]);
    map.setPaintProperty('streets', 'line-color', ['match',
      ['case', ['<=', ['get', 't'], t], ['get', 'status'], ['get', 'before']],
      'open', STATUS_COLOUR.open, 'special_access', STATUS_COLOUR.special_access, STATUS_COLOUR.blocked]);
    map.setFilter('callers-selected', ['==', ['get', 'id'], sel ?? '']);
    (map.getSource('callers') as GeoJSONSource).setData(
      callersFc(visibleCallers(d.callers, t), d.callersMeta.synthetic === true, st, uo));
    const ok = rts.filter((r) => !r.cut).flatMap((r) => r.edgeIds);
    const cut = rts.filter((r) => r.cut).flatMap((r) => r.edgeIds);
    map.setFilter('routes-casing', ['in', ['get', 'id'], ['literal', [...ok, ...cut]]]);
    map.setFilter('routes', ['in', ['get', 'id'], ['literal', ok]]);
    map.setFilter('routes-cut', ['in', ['get', 'id'], ['literal', cut]]);
    for (const [key, ids] of Object.entries(LAYER_GROUPS) as [LayerKey, string[]][]) {
      for (const id of ids) map.setLayoutProperty(id, 'visibility', on[key] ? 'visible' : 'none');
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
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

    map.on('load', () => {
      map.addSource('fire', { type: 'geojson', data: data.fire });
      map.addSource('streets', { type: 'geojson', data: data.streets });
      map.addSource('callers', { type: 'geojson', data: callersFc([], false, {}, (c) => c.urgency) });
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

      map.addLayer({ id: 'streets-near', type: 'line', source: 'streets',
        layout: { 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 9, 'line-opacity': 0.9 } });
      map.addLayer({ id: 'streets', type: 'line', source: 'streets', layout: { 'line-cap': 'round' },
        paint: {
          'line-color': STATUS_COLOUR.open,
          // Streets far from the fire stay on the map for routing but are drawn faint.
          'line-opacity': ['case', ['>', ['coalesce', ['get', 'fire_distance_km'], 0], data.streetsMeta.far_from_fire_km ?? 3], 0.22, 1],
          'line-width': ['interpolate', ['linear'], ['zoom'],
            10, ['match', ['get', 'highway'], 'track', 0.8, 1.8],
            14, ['match', ['get', 'highway'], 'track', 2.2, 4.5]],
        } });

      // Crew routes: drawn over the streets; a route cut by a newly blocked street turns dashed amber.
      map.addLayer({ id: 'routes-casing', type: 'line', source: 'streets', layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#083344', 'line-width': 9, 'line-opacity': 0.9 } });
      map.addLayer({ id: 'routes', type: 'line', source: 'streets', layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#22d3ee', 'line-width': 5 } });
      map.addLayer({ id: 'routes-cut', type: 'line', source: 'streets',
        paint: { 'line-color': '#fbbf24', 'line-width': 5, 'line-dasharray': [1.2, 1.2] } });

      map.addLayer({ id: 'forecast-pending', type: 'line', source: 'fire',
        paint: { 'line-color': HORIZON_COLOUR, 'line-width': 1.4, 'line-dasharray': [3, 3], 'line-opacity': 0.55 } });
      map.addLayer({ id: 'forecast-reached', type: 'line', source: 'fire',
        paint: { 'line-color': HORIZON_COLOUR, 'line-width': 3.5 } });
      map.addLayer({ id: 'forecast-label', type: 'symbol', source: 'fire',
        layout: { 'symbol-placement': 'line', 'text-field': ['concat', 'forecast +', ['to-string', ['get', 'horizon_hours']], ' h'],
          'text-font': ['Noto Sans Regular'], 'text-size': 11, 'symbol-spacing': 400 },
        paint: { 'text-color': '#fde68a', 'text-halo-color': '#07090d', 'text-halo-width': 1.5 } });

      map.addLayer({ id: 'responders', type: 'circle', source: 'responders',
        paint: { 'circle-radius': 8, 'circle-color': '#0e7490', 'circle-stroke-color': '#a5f3fc', 'circle-stroke-width': 2.5 } });
      map.addLayer({ id: 'responders-label', type: 'symbol', source: 'responders',
        layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11,
          'text-offset': [0, -1.4], 'text-anchor': 'bottom', 'text-allow-overlap': true },
        paint: { 'text-color': '#a5f3fc', 'text-halo-color': '#07090d', 'text-halo-width': 1.5 } });

      map.addLayer({ id: 'callers-selected', type: 'circle', source: 'callers',
        paint: { 'circle-radius': 17, 'circle-color': 'rgba(255,255,255,0.15)', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 } });
      map.addLayer({ id: 'callers', type: 'circle', source: 'callers',
        paint: { 'circle-radius': ['match', ['get', 'urgency'], 'life_threat', 9, 'urgent', 7.5, 6],
          'circle-color': ['get', 'colour'],
          'circle-stroke-color': ['match', ['get', 'stage'], 'new', '#07090d', ['get', 'ring']],
          'circle-stroke-width': ['match', ['get', 'stage'], 'new', 2, 'taken', 2.5, 3.5] } });
      map.addLayer({ id: 'callers-label', type: 'symbol', source: 'callers',
        layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 11,
          'text-offset': [0, 1.3], 'text-anchor': 'top', 'text-optional': true },
        paint: { 'text-color': '#f2f6fb', 'text-halo-color': '#07090d', 'text-halo-width': 1.5 } });

      const ign = data.fireMeta.ignition;
      if (ign) {
        const el = document.createElement('div');
        el.textContent = '★';
        el.title = ign.label ?? 'Ignition';
        el.style.cssText = 'font-size:22px;color:#fff;text-shadow:0 0 4px #000;line-height:1';
        new maplibregl.Marker({ element: el }).setLngLat([ign.lon, ign.lat]).addTo(map);
      }

      map.on('click', 'callers', (e) => onSelect(String(e.features?.[0]?.properties?.id ?? '') || null));
      map.on('click', 'streets', (e) => {
        if (map.queryRenderedFeatures(e.point, { layers: ['callers'] }).length) return;
        const p = e.features?.[0]?.properties as StreetAccess | undefined;
        if (!p) return;
        const { now: t, data: d } = latest.current;
        const st = statusAt(p, t);
        const tz = d.entry.timezone ?? 'UTC';
        const pending = (p.t ?? 0) > t ? `<br>Model: ${p.status.replace('_', ' ')} from ${fmtTime(p.t!, tz)}` : '';
        new maplibregl.Popup({ closeButton: false, maxWidth: '300px' }).setLngLat(e.lngLat).setHTML(
          `<b>${streetLabel(p)}</b><br><span style="color:#8a9bb3">${p.highway ?? 'road'} · OSM way ${p.osm_way_id}</span><br>`
          + `<span style="color:${STATUS_COLOUR[st]}">■</span> ${STATUS_SHORT[st]}`
          + (p.free_width_m != null ? `, free width ${p.free_width_m} m` : '')
          + ((p.t ?? 0) > 0 && (p.t ?? 0) <= t ? ` since ${fmtTime(p.t!, tz)}` : '') + pending
          + (p.reason ? `<br><span style="color:#8a9bb3">${p.reason}</span>` : '')
          + (p.imagery_date ? `<br>Imagery: ${p.imagery_date}` : '')
          + `<br>${p.confirmed_by_operator ? 'Confirmed by operator' : 'Not confirmed by an operator'} `
          + (p.synthetic ? '<span class="synthetic-tag">SYNTHETIC</span>'
            : p.basis === 'fire_model' ? '<span class="model-tag">MODEL OUTPUT</span>' : '')).addTo(map);
      });
      for (const id of ['callers', 'streets']) {
        map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
      }
      ready.current = true;
      sync();
    });
    });
    return () => { cancelled = true; ready.current = false; created?.remove(); mapRef.current = null; };
    // The map is rebuilt only when another scenario is loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  useEffect(sync);

  // Bring a newly selected caller into view.
  useEffect(() => {
    const c = data.callers.find((x) => x.id === selectedId);
    if (c && mapRef.current) mapRef.current.easeTo({ center: [c.place.lon, c.place.lat], zoom: Math.max(mapRef.current.getZoom(), 13.2) });
  }, [selectedId, data]);

  return (
    <>
      <div ref={container} className="h-full w-full" />
      {offline && (
        <span className="absolute left-2 top-2 rounded bg-ink-800/90 px-2 py-1 text-[11px] text-ink-200">
          Offline basemap (packaged copy, demo area only)
        </span>
      )}
    </>
  );
}
