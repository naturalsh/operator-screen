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
  /** Confidence now: noisy-OR of the evidence, each weight fading with its half-life, after any "no" answers. */
  p: number;
  /** Confidence from the reports alone, without fading (decides when a cluster becomes a candidate). */
  pReports: number;
  sources: number;
  candidate: boolean;
  /** Confidence has faded below EXPIRED_P: the place needs a new confirmation. */
  expired: boolean;
  confirmedAt: number | null;
  /** "Is the fire still there?" requests for this cluster sent by now, with the answers received by now. */
  asks: { ask: ConfirmationAsk; answer: ConfirmationAnswer | null }[];
}

/** Half-life of a piece of evidence: a call fades fast, a crew or drone sighting slower. */
export const HALF_LIFE_MIN = { caller: 40, crew: 180, drone: 180 } as const;
/** Below this the place is shown as expired. */
export const EXPIRED_P = 0.2;
/** Weight of a "yes": a crew on site 0.9; a caller on site 0.6, further away 0.3. */
export const YES_WEIGHT = { crew: 0.9, caller_on_site: 0.6, caller: 0.3 } as const;
/** A "no" multiplies the confidence: strongly from someone on site, a little from further away. */
export const NO_FACTOR = { on_site: 0.2, far: 0.7 } as const;

/** ConfirmationRequest (schemas/confirmation_request.schema.json), as the screen holds it. */
export interface ConfirmationAsk {
  id: string;
  cluster_id: string;
  report_id: string;
  target: { kind: 'crew' | 'caller'; ref: string; name: string; distance_m: number };
  channel: 'radio' | 'sms' | 'whatsapp' | 'voice';
  language: string;
  question_code: 'FIRE_STILL_THERE';
  sent_at: number;
  expires_at: number;
  mock: true;
}

/** ConfirmationResponse (schemas/confirmation_response.schema.json). */
export interface ConfirmationAnswer {
  request_id: string;
  answer: 'yes' | 'no' | 'unknown';
  answered_at: number;
  on_site: boolean;
  free_text: string;
  mock: true;
}

/** Noisy-OR over reports: strongest weight per source, capped at 0.5 while only one source has a weight. */
export function noisyOr(reports: { source_ref: string; confidence: number }[]): { p: number; sources: number } {
  const bySource = new Map<string, number>();
  for (const r of reports) bySource.set(r.source_ref, Math.max(bySource.get(r.source_ref) ?? 0, r.confidence));
  const ws = [...bySource.values()].filter((w) => w > 0);
  const p = 1 - ws.reduce((a, w) => a * (1 - w), 1);
  return { p: ws.length < 2 ? Math.min(p, SINGLE_SOURCE_CAP) : p, sources: ws.length };
}

const fade = (w: number, ageMin: number, halfLifeMin: number) => w * 0.5 ** (Math.max(0, ageMin) / halfLifeMin);

/**
 * Confidence of a place at `now` from everything received by then: each source's strongest weight fades from
 * when it last spoke (half-life by kind); a "yes" adds or refreshes a source; a "no" scales the result down.
 */
export function currentConfidence(reports: FireReport[], asks: { ask: ConfirmationAsk; answer: ConfirmationAnswer | null }[],
  now: number): number {
  const sources = new Map<string, { w: number; at: number; half: number }>();
  const add = (ref: string, w: number, at: number, half: number) => {
    const old = sources.get(ref);
    if (!old || fade(w, (now - at) / 60000, half) > fade(old.w, (now - old.at) / 60000, old.half)) sources.set(ref, { w, at, half });
  };
  for (const r of reports) if (r.confidence > 0) add(r.source_ref, r.confidence, Date.parse(r.observed_at), HALF_LIFE_MIN[r.kind]);
  let factor = 1;
  for (const { ask, answer } of asks) {
    if (!answer || answer.answered_at > now) continue;
    if (answer.answer === 'yes') {
      const w = ask.target.kind === 'crew' ? YES_WEIGHT.crew : answer.on_site ? YES_WEIGHT.caller_on_site : YES_WEIGHT.caller;
      add(ask.target.ref, w, answer.answered_at, HALF_LIFE_MIN[ask.target.kind]);
    } else if (answer.answer === 'no') {
      factor *= answer.on_site ? NO_FACTOR.on_site : NO_FACTOR.far;
    }
  }
  const ws = [...sources.values()].map((s) => fade(s.w, (now - s.at) / 60000, s.half));
  const p = 1 - ws.reduce((a, w) => a * (1 - w), 1);
  return (ws.length < 2 ? Math.min(p, SINGLE_SOURCE_CAP) : p) * factor;
}

/** Clusters with at least one report by `now`, with their confidence at `now`. */
export function clustersAt(concept: ConceptReports, now: number, confirmations: Map<string, number>,
  asks: { ask: ConfirmationAsk; answer: ConfirmationAnswer }[] = []): ClusterState[] {
  const byId = new Map(concept.records.map((r) => [r.id, r]));
  const out: ClusterState[] = [];
  for (const c of concept.clusters) {
    const reports = c.reports.map((id) => byId.get(id)!).filter((r) => Date.parse(r.observed_at) <= now);
    if (!reports.length) continue;
    const { p: pReports, sources } = noisyOr(reports);
    const mine = asks.filter((a) => a.ask.cluster_id === c.id && a.ask.sent_at <= now)
      .map((a) => ({ ask: a.ask, answer: a.answer.answered_at <= now ? a.answer : null }));
    const p = currentConfidence(reports, mine, now);
    const conf = confirmations.get(c.id);
    out.push({ cluster: c, reports, p, pReports, sources, candidate: sources >= 2 && pReports >= CANDIDATE_P,
      expired: p < EXPIRED_P, confirmedAt: conf != null && conf <= now ? conf : null, asks: mine });
  }
  return out.sort((a, b) => Number(b.candidate) - Number(a.candidate) || b.p - a.p);
}

/** Who to ask next: the nearest crew within ASK_CREW_KM first, then a person who reported the place. */
export const ASK_CREW_KM = 10;
export function nextAskTarget(state: ClusterState, crews: { id: string; name: string; position: [number, number]; busy: boolean }[]):
  ConfirmationAsk['target'] & { channel: ConfirmationAsk['channel']; language: string; reportId: string } | null {
  const asked = new Set(state.asks.map((a) => a.ask.target.ref));
  const c = state.cluster;
  const metres = (p: [number, number]) => Math.hypot((p[0] - c.lon) * 111320 * Math.cos((c.lat * Math.PI) / 180), (p[1] - c.lat) * 110540);
  const crew = crews.filter((k) => !asked.has(`crew:${k.id}`) && !k.busy && metres(k.position) <= ASK_CREW_KM * 1000)
    .sort((a, b) => metres(a.position) - metres(b.position))[0];
  const latest = state.reports[state.reports.length - 1];
  if (crew && !state.asks.some((a) => a.ask.target.kind === 'crew')) {
    return { kind: 'crew', ref: `crew:${crew.id}`, name: crew.name, distance_m: Math.round(metres(crew.position)),
      channel: 'radio', language: 'tr', reportId: latest.id };
  }
  // People who reported the place, those on site first; never the same number twice.
  const people = [...state.reports].filter((r) => !r.repeat_of_number && !asked.has(r.source_ref))
    .sort((a, b) => Number(b.observer_distance === 'on_site') - Number(a.observer_distance === 'on_site'));
  const r = people[0];
  if (r) {
    return { kind: 'caller', ref: r.source_ref, name: `the caller of ${r.place.label ?? 'this place'}`,
      distance_m: Math.round(metres([r.place.lon, r.place.lat])),
      channel: r.channel === 'voice' ? 'voice' : r.channel === 'sms' ? 'sms' : 'whatsapp', language: r.language, reportId: r.id };
  }
  if (crew) {
    return { kind: 'crew', ref: `crew:${crew.id}`, name: crew.name, distance_m: Math.round(metres(crew.position)),
      channel: 'radio', language: 'tr', reportId: latest.id };
  }
  return null;
}

/**
 * MOCK answer (no message is sent): a crew answers after ~8 min from the place, a caller after ~4 min. Where
 * there was fire the answer is "yes" (callers sometimes do not answer); where there was none, "no".
 * Deterministic for a request id. Only the mock uses the scenario's hidden truth.
 */
export function mockAnswer(ask: ConfirmationAsk, fireThere: boolean, observerOnSite: boolean): ConfirmationAnswer {
  let h = 2166136261;
  for (const ch of ask.id + ask.target.ref) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const u = (h % 1000) / 1000;
  const crew = ask.target.kind === 'crew';
  const delay = (crew ? 8 : 4) + Math.floor(u * 4);
  const answer: ConfirmationAnswer['answer'] = crew ? (fireThere ? 'yes' : 'no')
    : fireThere ? (u < 0.8 ? 'yes' : 'unknown') : (u < 0.7 ? 'no' : 'unknown');
  const text = {
    yes: crew ? 'Crew on site: active fire here.' : 'Yes, the fire is still here.',
    no: crew ? 'Crew on site: no fire here (a burning skip, now out).' : 'No, I do not see any fire now.',
    unknown: 'No answer.',
  }[answer];
  return { request_id: ask.id, answer, answered_at: ask.sent_at + delay * 60000, on_site: crew || observerOnSite,
    free_text: text, mock: true };
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

export const ASK_EXPIRES_MIN = 15;

export const STATEMENT_LABEL: Record<FireReport['statement_class'], string> = {
  flames_seen: 'sees flames', fire_near: 'fire close by', smoke: 'smoke', hearsay: 'heard of a fire',
};
export const LOCATION_LABEL: Record<FireReport['location_quality'], string> = {
  gps: 'GPS / pin', address: 'address', near_place: '"near" a place',
};
export const DISTANCE_LABEL: Record<FireReport['observer_distance'], string> = {
  on_site: 'on site', within_500m: 'within 500 m', far: 'far away',
};
