/**
 * CONCEPT DEMO: fire reports from people (synthetic, derived from later satellite passes), their clusters and
 * confidence, and the operator's confirmations.
 *
 * Confidence is a transparent noisy-OR, P = 1 - prod(1 - w_i), one weight per independent source (its strongest
 * report); w = statement x location quality x observer distance x independence (a repeat call from the same
 * number counts 0). One source never counts more than 0.5. A cluster is a candidate ("REPORTED (unconfirmed)")
 * once it has two independent sources and P >= 0.5. Clusters are formed in time order by the build script
 * (tools/build_concept_reports.py), so membership at a time only depends on earlier reports.
 */
import type { ConceptReports, FireReport, ReportCluster } from './types';

export const CONCEPT_LABEL = 'CONCEPT DEMO · synthetic reports derived from later satellite passes';
export const SINGLE_SOURCE_CAP = 0.5;
export const CANDIDATE_P = 0.5;

export interface ClusterState {
  cluster: ReportCluster;
  /** Reports received by now. */
  reports: FireReport[];
  p: number;
  sources: number;
  candidate: boolean;
  confirmedAt: number | null;
}

/** Noisy-OR over reports: strongest weight per source, capped at 0.5 while only one source has a weight. */
export function noisyOr(reports: { source_ref: string; confidence: number }[]): { p: number; sources: number } {
  const bySource = new Map<string, number>();
  for (const r of reports) bySource.set(r.source_ref, Math.max(bySource.get(r.source_ref) ?? 0, r.confidence));
  const ws = [...bySource.values()].filter((w) => w > 0);
  const p = 1 - ws.reduce((a, w) => a * (1 - w), 1);
  return { p: ws.length < 2 ? Math.min(p, SINGLE_SOURCE_CAP) : p, sources: ws.length };
}

/** Clusters with at least one report by `now`, with their confidence at `now`. */
export function clustersAt(concept: ConceptReports, now: number, confirmations: Map<string, number>): ClusterState[] {
  const byId = new Map(concept.records.map((r) => [r.id, r]));
  const out: ClusterState[] = [];
  for (const c of concept.clusters) {
    const reports = c.reports.map((id) => byId.get(id)!).filter((r) => Date.parse(r.observed_at) <= now);
    if (!reports.length) continue;
    const { p, sources } = noisyOr(reports);
    const conf = confirmations.get(c.id);
    out.push({ cluster: c, reports, p, sources, candidate: sources >= 2 && p >= CANDIDATE_P,
      confirmedAt: conf != null && conf <= now ? conf : null });
  }
  return out.sort((a, b) => Number(b.candidate) - Number(a.candidate) || b.p - a.p);
}

/** A circle as a GeoJSON polygon (for the uncertainty disc of a cluster). */
export function circle(lon: number, lat: number, radiusM: number, n = 48): GeoJSON.Polygon {
  const k = 111320 * Math.cos((lat * Math.PI) / 180);
  const ring = Array.from({ length: n + 1 }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return [lon + (radiusM * Math.sin(a)) / k, lat + (radiusM * Math.cos(a)) / 110540];
  });
  return { type: 'Polygon', coordinates: [ring] };
}

export const STATEMENT_LABEL: Record<FireReport['statement_class'], string> = {
  flames_seen: 'sees flames', fire_near: 'fire close by', smoke: 'smoke', hearsay: 'heard of a fire',
};
export const LOCATION_LABEL: Record<FireReport['location_quality'], string> = {
  gps: 'GPS / pin', address: 'address', near_place: '"near" a place',
};
export const DISTANCE_LABEL: Record<FireReport['observer_distance'], string> = {
  on_site: 'on site', within_500m: 'within 500 m', far: 'far away',
};
