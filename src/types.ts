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
  /** Time from which `status` holds; before it `status_before` (default open) applies. */
  valid_at?: string;
  status_before?: StreetStatus | null;
  basis?: 'imagery' | 'fire_model' | 'satellite' | 'fire_model_and_satellite' | 'operator';
  /** Which sources close the street within the scenario, and when each one does. */
  blocked_by?: 'model' | 'satellite' | 'both';
  first_blocked_by?: 'model' | 'satellite';
  model_blocked_at?: string;
  satellite_blocked_at?: string;
  /** Sensor behind the satellite closure, e.g. "VIIRS N20". */
  satellite_source?: string;
  /** A coarse (1 km) satellite pixel with fire covers the street: a warning, not a closure. */
  fire_nearby_at?: string;
  fire_nearby_source?: string;
  reason?: string;
  free_width_m: number | null;
  confidence?: number;
  imagery_date: string | null;
  /** Junction node ids of the segment (geometry runs u -> v) and its length; needed for routing. */
  u?: number;
  v?: number;
  length_m?: number;
  /** Nearest named place and a representative point [lon, lat], used to label unnamed streets. */
  near_place?: string;
  near_place_km?: number;
  label_point?: [number, number];
  /** Distance to the fire extent; far streets are drawn faint. */
  fire_distance_km?: number;
  /** Added on load: valid_at as epoch ms (0 = always) and the status before it; closure times per source
   * and the fire-nearby time as epoch ms (NEVER when absent). */
  t?: number;
  before?: StreetStatus;
  tm?: number;
  ts?: number;
  tn?: number;
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

/** A place crews are sent from. */
export interface Responder extends Provenance {
  id: string;
  name: string;
  kind: 'fire_station' | 'gendarmerie' | 'police' | 'other';
  place: { lon: number; lat: number };
}

/** What the operator has done with a report on this screen. */
export type Stage = 'new' | 'taken' | 'confirmed' | 'dispatched';

export interface Decision {
  seq: number;
  /** Wall-clock time of the click and the scenario time shown on screen at that moment (UTC). */
  decided_at: string;
  scenario_time: string;
  operator: string;
  report_id: string;
  action: 'take' | 'confirm_urgency' | 'dispatch' | 'dispatch_no_access' | 'reroute' | 'reroute_no_access';
  previous: string | null;
  new: string | null;
  note?: string;
  synthetic_report: boolean;
}

export interface FileMeta { record?: string; schema_version?: string; synthetic?: boolean; basis?: string; label?: string; note?: string; far_from_fire_km?: number }

export interface ScenarioEntry {
  id: string;
  title: string;
  center: [number, number];
  zoom: number;
  start: string;
  end: string;
  initial?: string;
  timezone?: string;
  files: { fire_front: string; caller_reports: string; street_access: string; responders?: string };
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
  responders: Responder[];
  respondersMeta: FileMeta;
}

export type StreetFeature = Feature<LineString | MultiLineString, StreetAccess>;
