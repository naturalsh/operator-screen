import { useEffect, useRef, useState } from 'react';
import maplibregl, { type ExpressionSpecification, type GeoJSONSource, type Map as MLMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  STAGE_COLOUR, STAGE_LABEL, STATUS_COLOUR, STATUS_SHORT, URGENCY_COLOUR, URGENCY_LABEL, URGENCY_ORDER,
  HORIZON_COLOURS, INITIAL_FORECAST_COLOUR, closureAt, closureSource, currentForecast, fireNearby, modelLabel, fmtAge, fmtTime, statusAt, streetLabel, visibleCallers,
} from '../data';
import { resolveBasemap } from '../basemap';
import type { CallerReport, FireFront, ScenarioData, Stage, StreetAccess, Urgency } from '../types';

export type LayerKey = 'forecast' | 'initial' | 'observed' | 'streets' | 'callers' | 'crews';

const LAYER_GROUPS: Record<LayerKey, string[]> = {
  forecast: ['forecast-pending', 'forecast-reached', 'forecast-label'],
  initial: ['initial-pending', 'initial-reached', 'initial-label'],
  observed: ['hotspots', 'burned-area', 'flame-front'],
  streets: ['streets-near', 'streets-nearby', 'streets', 'streets-sat'],
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
  /** Pixels of the map covered by the phone drawer (bottom, portrait) or side panel (right, landscape);
   * a selected caller is centred in the part that stays visible. */
  insetBottom?: number;
  insetRight?: number;
  /** Start zoomed to the fire (forecast contours) instead of the scenario's default view; used on phones. */
  fitFire?: boolean;
}

export function MapView({ data, now, layers, selectedId, nearIds, stages, routes, urgencyOf, onSelect, insetBottom = 0, insetRight = 0, fitFire = false }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const ready = useRef(false);
  const popupRef = useRef<maplibregl.Popup | null>(null);
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
    // The forecast in force: the latest update issued by now (dashed until each horizon is reached).
    const cur = currentForecast(d.fire.features.map((f) => f.properties), t);
    const inForce: ExpressionSpecification = ['all', kind('forecast'), ['==', ['get', 'set'], cur?.set ?? 'none'],
      ['==', ['get', 'issue_t'], cur?.issuedAt ?? -1]];
    map.setFilter('forecast-reached', ['all', inForce, upTo]);
    map.setFilter('forecast-label', inForce);
    map.setFilter('forecast-pending', ['all', inForce, ['>', ['get', 't'], t]]);
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
    const satOnly: ExpressionSpecification = ['all', ['<=', ['coalesce', ['get', 'ts'], 9e15], t], ['>', ['coalesce', ['get', 'tm'], 9e15], t]];
    map.setFilter('streets-sat', satOnly);
    map.setFilter('streets', ['!', satOnly]);
    // Fire nearby: a coarse pixel covers the street and neither source has closed it yet. (Not `t > now`:
    // a street that is never closed has t = scenario start.)
    map.setFilter('streets-nearby', ['all', ['<=', ['coalesce', ['get', 'tn'], 9e15], t],
      ['>', ['coalesce', ['get', 'tm'], 9e15], t], ['>', ['coalesce', ['get', 'ts'], 9e15], t]]);
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
    if (fitFire) {
      // Bounding box of the forecast contours, so a narrow screen starts on the fire.
      const box = new maplibregl.LngLatBounds();
      const add = (c: unknown): void => {
        if (Array.isArray(c) && typeof c[0] === 'number') box.extend(c as [number, number]);
        else if (Array.isArray(c)) c.forEach(add);
      };
      for (const f of data.fire.features) if (f.properties.kind === 'forecast' && 'coordinates' in f.geometry) add(f.geometry.coordinates);
      if (!box.isEmpty()) map.fitBounds(box, { padding: { top: 24, left: 24, right: 24 + insetRight, bottom: 24 + insetBottom }, animate: false });
    }
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

    map.on('load', () => {
      map.addSource('fire', { type: 'geojson', data: data.fire });
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
          'line-opacity': ['case', ['>', ['coalesce', ['get', 'fire_distance_km'], 0], data.streetsMeta.far_from_fire_km ?? 3], 0.22, 1],
          'line-width': ['interpolate', ['linear'], ['zoom'],
            10, ['match', ['get', 'highway'], 'track', 0.8, 1.8],
            14, ['match', ['get', 'highway'], 'track', 2.2, 4.5]],
        } });

      // Satellite-only closures: red like the model's, but dashed (on a dark casing so the gaps read).
      map.addLayer({ id: 'streets-sat', type: 'line', source: 'streets',
        paint: { 'line-color': STATUS_COLOUR.blocked, 'line-dasharray': [1.6, 1.4],
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
      const CLICKABLE = ['callers', 'responders', 'streets', 'streets-sat', 'flame-front', 'forecast-reached', 'forecast-pending',
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
        } else if (hit.layer.id === 'streets' || hit.layer.id === 'streets-sat') {
          // Rendered features carry nested values (label_point) as JSON text, so read the street from the data.
          const p = d.streets.features.find((f) => f.properties.id === hit.properties.id)?.properties
            ?? (hit.properties as StreetAccess);
          const now = statusAt(p, t);
          const closure = closureAt(p, t);
          html = `<b>${streetLabel(p)}</b>` + muted(`${p.highway ?? 'road'} · OSM way ${p.osm_way_id}`)
            + `<div><span style="color:${STATUS_COLOUR[now]}">■</span> ${STATUS_SHORT[now]}`
            + (p.free_width_m != null ? `, free width ${p.free_width_m} m` : '')
            + (closure ? ` since ${fmtTime(closure.since, tz)} — ${closureSource(p, closure)}`
              : (p.t ?? 0) > 0 && (p.t ?? 0) <= t && p.status !== p.before ? ` since ${fmtTime(p.t!, tz)}` : '') + '</div>'
            + (closure?.by === 'both' ? muted(`model from ${fmtTime(p.tm!, tz)} · satellite from ${fmtTime(p.ts!, tz)}`) : '')
            + ((p.t ?? 0) > t ? `<div>Expected: ${p.status.replace('_', ' ')} from ${fmtTime(p.t!, tz)}`
              + `${p.first_blocked_by ? ` (${p.first_blocked_by})` : ''}</div>` : '')
            + (fireNearby(p, t) ? `<div style="color:#fbbf24">⚠ Fire nearby (satellite): ${p.fire_nearby_source ?? '1 km pixel'} `
              + `since ${fmtTime(p.tn!, tz)}. 1 km pixel, too coarse to close the street.</div>` : '')
            + (p.reason && closure ? muted(p.reason) : '')
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
    return () => { cancelled = true; ready.current = false; popupRef.current?.remove(); created?.remove(); mapRef.current = null; };
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
