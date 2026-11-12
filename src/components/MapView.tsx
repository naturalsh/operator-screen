import { useEffect, useRef } from 'react';
import maplibregl, { type ExpressionSpecification, type GeoJSONSource, type Map as MLMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { STATUS_COLOUR, STATUS_LABEL, URGENCY_COLOUR, visibleCallers } from '../data';
import type { CallerReport, ScenarioData, StreetAccess } from '../types';

export type LayerKey = 'forecast' | 'observed' | 'streets' | 'callers';

/** Basemap: OpenFreeMap dark vector style (OSM data, no API key). */
const BASE_STYLE = 'https://tiles.openfreemap.org/styles/dark';

const LAYER_GROUPS: Record<LayerKey, string[]> = {
  forecast: ['forecast-pending', 'forecast-reached', 'forecast-label'],
  observed: ['hotspots', 'burned-area', 'flame-front'],
  streets: ['streets-near', 'streets'],
  callers: ['callers-selected', 'callers', 'callers-label'],
};

const HORIZON_COLOUR = ['match', ['get', 'horizon_hours'], 8, '#fde047', 20, '#fb923c', '#f97316'] as unknown as string;
const INSTRUMENT_COLOUR = ['match', ['get', 'instrument'], 'MODIS', '#a855f7', 'SLSTR', '#14b8a6', '#ef4444'] as unknown as string;

function callersFc(callers: CallerReport[], synthetic: boolean): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: callers.map((c) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [c.place.lon, c.place.lat] },
      properties: { id: c.id, urgency: c.urgency, colour: URGENCY_COLOUR[c.urgency],
        label: `${c.people_at_risk > 0 ? `${c.people_at_risk} · ` : ''}${c.place.label ?? ''}${synthetic ? ' (synthetic)' : ''}` },
    })),
  };
}

interface Props {
  data: ScenarioData;
  now: number;
  layers: Record<LayerKey, boolean>;
  selectedId: string | null;
  nearIds: string[];
  onSelect: (id: string | null) => void;
}

export function MapView({ data, now, layers, selectedId, nearIds, onSelect }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const ready = useRef(false);
  const latest = useRef({ now, layers, selectedId, nearIds, data });
  latest.current = { now, layers, selectedId, nearIds, data };

  /** Push the current time, selection and toggles into the map. */
  const sync = () => {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    const { now: t, layers: on, selectedId: sel, nearIds: near, data: d } = latest.current;
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
    map.setFilter('callers-selected', ['==', ['get', 'id'], sel ?? '']);
    (map.getSource('callers') as GeoJSONSource).setData(
      callersFc(visibleCallers(d.callers, t), d.callersMeta.synthetic === true));
    for (const [key, ids] of Object.entries(LAYER_GROUPS) as [LayerKey, string[]][]) {
      for (const id of ids) map.setLayoutProperty(id, 'visibility', on[key] ? 'visible' : 'none');
    }
  };

  useEffect(() => {
    const map = new maplibregl.Map({
      container: container.current!,
      style: BASE_STYLE,
      center: data.entry.center,
      zoom: data.entry.zoom,
      attributionControl: { compact: true },
      preserveDrawingBuffer: true, // lets the canvas be captured (screenshots)
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

    map.on('load', () => {
      map.addSource('fire', { type: 'geojson', data: data.fire });
      map.addSource('streets', { type: 'geojson', data: data.streets });
      map.addSource('callers', { type: 'geojson', data: callersFc([], false) });

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
          'line-color': ['match', ['get', 'status'], 'open', STATUS_COLOUR.open,
            'special_access', STATUS_COLOUR.special_access, STATUS_COLOUR.blocked],
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.6, 14, 4],
        } });

      map.addLayer({ id: 'forecast-pending', type: 'line', source: 'fire',
        paint: { 'line-color': HORIZON_COLOUR, 'line-width': 1.4, 'line-dasharray': [3, 3], 'line-opacity': 0.55 } });
      map.addLayer({ id: 'forecast-reached', type: 'line', source: 'fire',
        paint: { 'line-color': HORIZON_COLOUR, 'line-width': 3.5 } });
      map.addLayer({ id: 'forecast-label', type: 'symbol', source: 'fire',
        layout: { 'symbol-placement': 'line', 'text-field': ['concat', 'forecast +', ['to-string', ['get', 'horizon_hours']], ' h'],
          'text-font': ['Noto Sans Regular'], 'text-size': 11, 'symbol-spacing': 400 },
        paint: { 'text-color': '#fde68a', 'text-halo-color': '#07090d', 'text-halo-width': 1.5 } });

      map.addLayer({ id: 'callers-selected', type: 'circle', source: 'callers',
        paint: { 'circle-radius': 17, 'circle-color': 'rgba(255,255,255,0.15)', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 } });
      map.addLayer({ id: 'callers', type: 'circle', source: 'callers',
        paint: { 'circle-radius': ['match', ['get', 'urgency'], 'life_threat', 9, 'urgent', 7.5, 6],
          'circle-color': ['get', 'colour'], 'circle-stroke-color': '#07090d', 'circle-stroke-width': 2 } });
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
        new maplibregl.Popup({ closeButton: false }).setLngLat(e.lngLat).setHTML(
          `<b>${p.name ?? 'Unnamed street'}</b> · OSM way ${p.osm_way_id}<br>`
          + `<span style="color:${STATUS_COLOUR[p.status]}">■</span> ${STATUS_LABEL[p.status]}, free width ${p.free_width_m} m<br>`
          + `Imagery: ${p.imagery_date}${p.confirmed_by_operator ? ' · confirmed by operator' : ' · not confirmed'}`
          + (p.synthetic ? '<br><span class="synthetic-tag">SYNTHETIC</span>' : '')).addTo(map);
      });
      for (const id of ['callers', 'streets']) {
        map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
      }
      ready.current = true;
      sync();
    });
    return () => { ready.current = false; map.remove(); };
    // The map is rebuilt only when another scenario is loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  useEffect(sync);

  // Bring a newly selected caller into view.
  useEffect(() => {
    const c = data.callers.find((x) => x.id === selectedId);
    if (c && mapRef.current) mapRef.current.easeTo({ center: [c.place.lon, c.place.lat], zoom: Math.max(mapRef.current.getZoom(), 13.2) });
  }, [selectedId, data]);

  return <div ref={container} className="h-full w-full" />;
}
