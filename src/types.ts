/**
 * Shapes of the three records the operator screen reads. They mirror
 * schemas/*.schema.json; the data files are the only thing that changes when
 * the real Voice intake and Road Check exports replace the synthetic samples.
 */
import type { Feature, FeatureCollection, Geometry, LineString, MultiLineString } from 'geojson';

export type Urgency = 'life_threat' | 'urgent' | 'routine';
export type StreetStatus = 'open' | 'special_access' | 'blocked';

/** Provenance carried by every record. */
export interface Provenance {
  schema_version: string;
  source: string;
  source_url: string;
  license: string;
  fetched_at: string;
  observed_at: string;
  received_at: string;
  synthetic?: boolean;
}

export interface CallerReport extends Provenance {
  id: string;
  reported_at: string;
  place: { lon: number; lat: number; label?: string };
  language: string;
  urgency: Urgency;
  urgency_reasons: string[];
  hazard: string;
  people_at_risk: number;
  channel?: string;
  summary: string;
  summary_en?: string;
  confirmed_by_operator: boolean;
}

export interface StreetAccess extends Provenance {
  id: string;
  osm_way_id: number;
  edge_id?: string;
  name: string | null;
  highway?: string;
  status: StreetStatus;
  free_width_m: number;
  confidence?: number;
  imagery_date: string;
  imagery_source?: string;
  confirmed_by_operator: boolean;
}

export interface FireFront extends Provenance {
  id: string;
  kind: 'forecast' | 'observed';
  valid_at: string;
  area_km2?: number;
  horizon_hours?: number;
  probability?: number;
  model_run_at?: string;
  observation_type?: 'hotspots' | 'flame_front' | 'burned_area';
  instrument?: string;
  satellite?: string;
  detections?: number;
  frp_mw?: number;
}

export interface FileMeta { record?: string; schema_version?: string; synthetic?: boolean; note?: string }

export interface ScenarioEntry {
  id: string;
  title: string;
  center: [number, number];
  zoom: number;
  start: string;
  end: string;
  initial?: string;
  timezone?: string;
  files: { fire_front: string; caller_reports: string; street_access: string };
}

export interface FireMeta extends FileMeta {
  ignition?: { lon: number; lat: number; at: string; label?: string };
  disclaimer?: string;
}

export interface ScenarioData {
  entry: ScenarioEntry;
  fire: FeatureCollection<Geometry, FireFront & { t: number }>;
  fireMeta: FireMeta;
  streets: FeatureCollection<LineString | MultiLineString, StreetAccess>;
  streetsMeta: FileMeta;
  callers: CallerReport[];
  callersMeta: FileMeta;
}

export type StreetFeature = Feature<LineString | MultiLineString, StreetAccess>;
