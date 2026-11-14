import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  HORIZON_COLOURS, URGENCY_LABEL, aheadContours, fileKind, fmtTime, loadIndex, loadScenario, modelLabel, streetLabel, streetsNear, visibleCallers,
} from './data';
import {
  CREW_STATUS_LABEL, DEFAULT_ON_SCENE_MIN, candidatesFor, crewStateAt, makeCrews, missionTimes, reportMissionAt, rewriteFuture, withReturn,
  type Candidate, type Mission,
} from './crews';
import { SNAP_WARN_M, buildGraph, planLegs } from './routing';
import {
  LiveForecasts, PrecomputedForecasts, applyForecastClosures, forecastClosures, forecastInForce, historyLoads, loadAt, newObservations,
  type ForecastLoad, type ForecastSource,
} from './forecast';
import { ForecastControl } from './components/ForecastControl';
import { ConceptPanel } from './components/ConceptPanel';
import {
  ASK_EXPIRES_MIN, CONCEPT_LABEL, clustersAt, mockAnswer, nextAskTarget, type ConfirmationAnswer, type ConfirmationAsk,
} from './reports';
import type { CallerReport, Decision, ScenarioData, ScenarioEntry, StreetFeature, Urgency } from './types';
import { CallerList, NEAR_RADIUS_M, type CardCrew, type CaseState } from './components/CallerList';
import { DecisionLog } from './components/DecisionLog';
import { MapView, type LayerKey, type MapMode, type Vehicle } from './components/MapView';
import { SidePanel } from './components/SidePanel';
import { TimeBar } from './components/TimeBar';
import { useMediaQuery } from './useMediaQuery';

const TICK_MS = 100;

/**
 * `?scenario=<id>&t=<ISO time>&call=<report id>&basemap=offline` deep-links to a moment (handy for rehearsals);
 * `?demo=1` opens the scenario's rehearsed demo scene.
 */
const params = new URLSearchParams(location.search);
const wantDemo = params.get('demo') === '1';
/** `?forecast_api=http://localhost:8000` asks a live model server first (docs/forecast_api.md). */
const forecastApi = params.get('forecast_api');

const mins = (m: number) => `${Math.max(1, Math.ceil(m))} min`;

export function App() {
  const [scenarios, setScenarios] = useState<ScenarioEntry[]>([]);
  const [scenarioId, setScenarioId] = useState<string | null>(params.get('scenario'));
  const [data, setData] = useState<ScenarioData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(params.get('call'));
  const [layers, setLayers] = useState<Record<LayerKey, boolean>>({
    forecast: true, initial: false, observed: true, streets: true, nearby: false, callers: true, crews: true,
    // CONCEPT DEMO (synthetic fire reports): off unless asked for, `?concept=1` turns it on.
    concept: params.get('concept') === '1',
  });
  // Simple (default) shows what a newcomer needs; Detailed shows every source. `?mode=detailed` deep-links.
  const [mode, setMode] = useState<MapMode>(params.get('mode') === 'detailed' ? 'detailed' : 'simple');
  const [operator, setOperator] = useState('operator-1');
  const [cases, setCases] = useState<Record<string, CaseState>>({});
  const [missions, setMissions] = useState<Mission[]>([]);
  const [onSceneMin, setOnSceneMin] = useState(DEFAULT_ON_SCENE_MIN);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [tab, setTab] = useState<'reports' | 'overview' | 'log'>('reports');
  const [focus, setFocus] = useState<{ lon: number; lat: number; key: number } | null>(null);
  // Phone layout (below 768 px): full-screen map, a bottom drawer with three tabs, a fixed time bar.
  const narrow = useMediaQuery('(max-width: 767px)');
  // A phone held sideways: little height, so one header line, a thin time bar and a panel from the right.
  const landscape = useMediaQuery('(max-height: 500px)');
  const phone = narrow || landscape;
  // Tablets and small laptops (768-1279 px): one side panel with tabs, so the map keeps most of the width.
  const medium = useMediaQuery('(max-width: 1279px)');
  // From 1600 px both side panels at full width; between 1280 and 1599 px they are narrower.
  const roomy = useMediaQuery('(min-width: 1600px)');
  const [drawer, setDrawer] = useState<'reports' | 'layers' | 'log' | null>(null);
  // True once the service worker has stored the whole site (built site only): it then opens without a network.
  const [offlineReady, setOfflineReady] = useState(false);
  // (The worker is registered on the page's load event, after this runs, so wait for `ready` rather than asking
  // for the registration now.)
  useEffect(() => {
    if (import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.ready.then(() => setOfflineReady(true));
  }, []);
  const mainRef = useRef<HTMLElement>(null);
  const missionSeq = useRef(0);
  // Forecasts: the precomputed library and the forecasts the operator has loaded (the one in force is the last
  // loaded by the time shown; it never changes by itself).
  const [precomputed, setPrecomputed] = useState<PrecomputedForecasts | null>(null);
  const [loads, setLoads] = useState<ForecastLoad[]>([]);
  const loadSeq = useRef(0);
  const [forecastBusy, setForecastBusy] = useState(false);
  const [fireVersion, setFireVersion] = useState(0);
  // CONCEPT DEMO: report clusters the operator confirmed, and when (scenario time).
  const [confirmations, setConfirmations] = useState<Map<string, number>>(new Map());
  // "Is the fire still there?" requests (MOCK: answered by mockAnswer, nothing is sent).
  const [asks, setAsks] = useState<{ ask: ConfirmationAsk; answer: ConfirmationAnswer }[]>([]);
  const askSeq = useRef(0);

  useEffect(() => {
    loadIndex().then((list) => {
      setScenarios(list);
      setScenarioId((id) => (list.some((s) => s.id === id) ? id : list[0]?.id ?? null));
    }).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    const entry = scenarios.find((s) => s.id === scenarioId);
    if (!entry) return;
    setData(null);
    setPlaying(false);
    setCases({});
    setMissions([]);
    setDecisions([]);
    setLoads([]);
    setPrecomputed(null);
    setConfirmations(new Map());
    setAsks([]);
    loadScenario(entry).then((d) => {
      const demo = wantDemo ? entry.demo : undefined;
      const t0 = Date.parse(demo?.t ?? '') || Date.parse(params.get('t') ?? '') || Date.parse(entry.initial ?? entry.start);
      const t = Math.min(Math.max(t0, Date.parse(entry.start)), Date.parse(entry.end));
      if (demo?.call) setSelectedId(demo.call);
      // Before the opening time the forecast was updated at every new satellite pass (the previous shift);
      // from then on it changes only when the operator loads one.
      const pre = d.library ? new PrecomputedForecasts(d.library, d.concept) : null;
      if (pre) {
        d.fire.features.push(...pre.runs.flatMap((r) => r.features));
        const history = historyLoads(pre, t);
        loadSeq.current = history.length;
        setLoads(history);
      }
      setPrecomputed(pre);
      setNow(t);
      setData(d);
    }).catch((e) => setError(String(e)));
  }, [scenarios, scenarioId]);

  const start = data ? Date.parse(data.entry.start) : 0;
  const end = data ? Date.parse(data.entry.end) : 0;

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setNow((t) => {
      const next = t + speed * 3600000 * (TICK_MS / 1000);
      if (next >= end) setPlaying(false);
      return Math.min(next, end);
    }), TICK_MS);
    return () => clearInterval(id);
  }, [playing, speed, end]);

  const graph = useMemo(() => (data ? buildGraph(data.streets.features) : null), [data]);
  const source: ForecastSource | null = useMemo(
    () => (precomputed && forecastApi ? new LiveForecasts(forecastApi, precomputed) : precomputed), [precomputed]);
  // Forecast closures follow the forecasts the operator loaded; written into the street records, which routing and
  // the map read. `streetsVersion` changes whenever they do.
  const streetsVersion = useMemo(() => {
    if (!data || !precomputed) return 0;
    const tz = data.entry.timezone ?? 'UTC';
    applyForecastClosures(data.streets.features, forecastClosures(loads, precomputed.first), (x) => `${fmtTime(x, tz)} local`);
    return loadSeq.current * 1000 + loads.length;
  }, [data, precomputed, loads]);
  const inForce = useMemo(() => (precomputed ? forecastInForce(loads, precomputed.first, now) : null), [precomputed, loads, now]);
  const forecastRunId: string | null | undefined = precomputed ? inForce?.run.id ?? null : undefined;
  const streetById = useMemo(
    () => new Map<string, StreetFeature>((data?.streets.features ?? []).map((s) => [s.properties.id, s])), [data]);
  const timeZone = data?.entry.timezone ?? 'UTC';
  const labelOf = useCallback((id: string) => data?.callers.find((c) => c.id === id)?.place.label ?? id, [data]);
  const shortLabel = (id: string) => labelOf(id).split(' (')[0];

  // Crews: where each one is at the time shown, derived from the missions created so far.
  const crews = useMemo(() => (data ? makeCrews(data.responders) : []), [data]);
  const crewStates = useMemo(() => crews.map((c) => crewStateAt(c, missions, now, streetById)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [crews, missions, now, streetById, streetsVersion]);

  // The operator's case state as it was at the time shown: dispatch and redirect follow the missions, so moving
  // the clock back before a dispatch shows the report as not dispatched again.
  const viewCases = useMemo(() => {
    const out: Record<string, CaseState> = {};
    for (const [id, cs] of Object.entries(cases)) {
      const at = reportMissionAt(id, missions, now);
      if (at.stage === 'dispatched') out[id] = { ...cs, stage: 'dispatched', missionId: at.mission!.id };
      else if (at.stage === 'unassigned') out[id] = { ...cs, stage: 'unassigned', missionId: undefined };
      else if (cs.stage === 'dispatched' || cs.stage === 'unassigned') out[id] = { ...cs, stage: 'confirmed', missionId: undefined, unassignedNote: undefined };
      else out[id] = cs;
    }
    return out;
  }, [cases, missions, now]);

  const urgencyOf = useCallback((c: CallerReport) => cases[c.id]?.urgency ?? c.urgency, [cases]);
  const callers = useMemo(
    () => (data ? visibleCallers(data.callers, now, urgencyOf, (c) => viewCases[c.id]?.stage === 'unassigned') : []),
    [data, now, urgencyOf, viewCases]);
  const selected = callers.find((c) => c.id === selectedId) ?? null;
  const nearIds = useMemo(
    () => (data && selected ? streetsNear(data.streets.features, selected, NEAR_RADIUS_M).map((n) => n.street.properties.id) : []),
    [data, selected]);

  // Crews that could go to the selected report (only computed for the report the operator is looking at).
  const selectedStage = selected ? viewCases[selected.id]?.stage : undefined;
  const candidates = useMemo(() => {
    if (!graph || !selected || !(selectedStage === 'confirmed' || selectedStage === 'unassigned')) return null;
    return candidatesFor(graph, [selected.place.lon, selected.place.lat], crewStates, now);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, selected, selectedStage, crewStates, now, streetsVersion]);

  // What each dispatched report's card says about its crew at the time shown.
  const cardCrews = useMemo(() => {
    const out: Record<string, CardCrew> = {};
    if (!graph) return out;
    for (const [reportId, cs] of Object.entries(viewCases)) {
      const m = missions.find((x) => x.id === cs.missionId);
      const crew = m && crews.find((c) => c.id === m.crewId);
      if (!m || !crew || cs.stage !== 'dispatched') continue;
      const state = crewStates.find((s) => s.crew.id === crew.id)!;
      const mine = state.mission?.id === m.id;
      const times = missionTimes(m, streetById);
      const last = m.legs[m.legs.length - 1];
      // A crew whose state no longer points at this mission has finished it.
      const status = mine ? state.status : 'available';
      let cutStreet: string | null = null;
      let alternative: CardCrew['alternative'] = null;
      if (mine && state.status === 'holding') {
        const leg = [...m.legs].reverse().find((l) => l.startAt <= now) ?? last;
        const cut = leg.spans.map((s) => streetById.get(s.edgeId)).find((s) => s && s.properties.status === 'blocked'
          && (s.properties.t ?? 0) > leg.startAt && (s.properties.t ?? 0) <= now);
        cutStreet = cut ? streetLabel(cut.properties) : null;
        const alt = state.node != null ? planLegs(graph, m.target, [{ id: crew.id, name: crew.name, node: state.node }], now)[0] : undefined;
        alternative = alt ? { minutes: alt.leg.minutes, km: alt.leg.km } : null;
      }
      out[reportId] = {
        crewName: crew.name, status, etaMin: mine ? state.etaMin : null,
        km: m.legs.reduce((a, l) => a + l.km, 0), trackKm: m.legs.reduce((a, l) => a + l.trackKm, 0),
        sentAt: m.createdAt, arrivedAt: times.arriveAt, leftAt: times.leaveAt,
        lastStretchBlocked: m.lastStretchBlocked, lastStretchM: m.lastStretchM, cutOff: mine && state.cutOff,
        holdFrom: times.holdFrom, cutStreet, alternative,
        snapWarnings: [
          (m.originSnapM ?? 0) > SNAP_WARN_M ? `${crew.stationName} is ${Math.round(m.originSnapM!)} m from the nearest mapped road (straight connector assumed in the ETA)` : '',
          (m.targetSnapM ?? 0) > SNAP_WARN_M ? `the caller is ${Math.round(m.targetSnapM!)} m from the nearest mapped road; the route ends there` : '',
        ].filter(Boolean),
      };
    }
    return out;
  }, [graph, viewCases, missions, crews, crewStates, streetById, now]);

  const awaiting = useMemo(() => callers.filter((c) => ['confirmed', 'unassigned'].includes(viewCases[c.id]?.stage ?? 'new'))
    .map((c) => ({ id: c.id, label: c.place.label ?? c.id })), [callers, viewCases]);

  const record = useCallback((c: { id: string; synthetic?: boolean }, action: Decision['action'], previous: string | null,
    next: string | null, note?: string) => {
    setDecisions((log) => [...log, {
      seq: log.length + 1,
      decided_at: new Date().toISOString(),
      scenario_time: new Date(now).toISOString(),
      operator: operator.trim() || 'unnamed operator',
      report_id: c.id, action, previous, new: next, note,
      synthetic_report: c.synthetic === true,
    }]);
  }, [now, operator]);

  const patchCase = (id: string, patch: Partial<CaseState>) =>
    setCases((all) => ({ ...all, [id]: { ...(all[id] ?? { stage: 'new' }), ...patch } }));

  const onTake = (c: CallerReport) => {
    patchCase(c.id, { stage: 'taken' });
    record(c, 'take', 'new', 'taken');
  };
  const onConfirm = (c: CallerReport, urgency: Urgency) => {
    patchCase(c.id, { stage: 'confirmed', urgency });
    const suggested = c.synthetic ? 'synthetic scenario value' : 'agent suggestion';
    record(c, 'confirm_urgency', `${URGENCY_LABEL[c.urgency]} (${suggested})`, URGENCY_LABEL[urgency],
      urgency === c.urgency ? `${suggested} confirmed` : `${suggested} changed by the operator`);
  };

  /** Sends a crew to a report. A crew that was on its way elsewhere leaves that incident unassigned. */
  const send = (c: CallerReport, k: Candidate) => {
    if (!graph) return;
    const old = k.state.mission;
    const taken = old && k.needsApproval ? data?.callers.find((x) => x.id === old.reportId) : undefined;
    const id = ++missionSeq.current;
    const mission = withReturn(graph, {
      id, crewId: k.crew.id, reportId: c.id, createdAt: now, legs: [k.leg], target: [c.place.lon, c.place.lat],
      lastStretchBlocked: k.lastStretchBlocked, lastStretchM: k.lastStretchM, onSceneMin, back: null,
      originSnapM: k.state.status === 'available' ? k.originSnapM : 0, targetSnapM: k.targetSnapM,
    }, k.crew, streetById);
    // Decisions later on the timeline for this crew or this report are replaced by this one; whatever the crew
    // was doing at `now` (driving elsewhere, or driving home) ends now.
    setMissions((all) => [...rewriteFuture(all, now, k.crew.id, c.id).map((m) => (old && m.id === old.id ? { ...m, cancelledAt: now } : m)), mission]);
    const what = `${k.crew.name}, ETA ${mins(k.minutes)}, ${k.leg.km.toFixed(1)} km`;
    const blockedNote = k.lastStretchBlocked ? `caller's street is blocked: crew stops ${Math.round(k.lastStretchM)} m away` : undefined;
    if (taken) {
      const note = `${k.crew.name} was redirected to ${shortLabel(c.id)} at ${fmtTime(now, timeZone)}`;
      patchCase(taken.id, { stage: 'unassigned', missionId: undefined, unassignedNote: note });
      record(taken, 'unassigned', `${k.crew.name} ${CREW_STATUS_LABEL[k.state.status].toLowerCase()}`, 'unassigned', `crew redirected to ${shortLabel(c.id)}`);
      record(c, 'reassign', viewCases[c.id]?.stage === 'unassigned' ? 'unassigned' : 'not dispatched', what,
        [`crew taken from ${shortLabel(taken.id)}`, blockedNote].filter(Boolean).join('; '));
    } else {
      record(c, 'dispatch', viewCases[c.id]?.stage === 'unassigned' ? 'unassigned' : 'not dispatched', what,
        [k.state.status === 'returning' ? 'crew was returning to its station' : '', blockedNote].filter(Boolean).join('; ') || undefined);
    }
    patchCase(c.id, { stage: 'dispatched', missionId: id, noAccessAt: undefined, noCrewAt: undefined, noCrewNote: undefined, unassignedNote: undefined });
    setSelectedId(c.id);
  };

  const onDispatch = (c: CallerReport, crewId?: string) => {
    if (!data || !graph) return;
    const target: [number, number] = [c.place.lon, c.place.lat];
    const list = candidatesFor(graph, target, crewStates, now);
    const pick = crewId ? list.find((k) => k.crew.id === crewId) : list.find((k) => !k.needsApproval);
    if (pick) { send(c, pick); return; }
    // Nobody to send: is it the roads, or are all crews busy?
    const byRoad = planLegs(graph, target, data.responders.map((r) => ({ id: r.id, name: r.name, place: [r.place.lon, r.place.lat] as [number, number] })), now);
    if (!byRoad.length) {
      patchCase(c.id, { noAccessAt: now, noCrewAt: undefined });
      record(c, 'dispatch_no_access', 'not dispatched', 'no access by road', 'every route is cut by blocked streets');
    } else {
      const busy = crewStates.filter((s) => s.status !== 'available' && s.status !== 'returning');
      const note = `${busy.filter((s) => s.status === 'on_scene').length} on scene, `
        + `${busy.filter((s) => s.status !== 'on_scene').length} en route (a crew en route can be redirected from the list)`;
      patchCase(c.id, { noCrewAt: now, noCrewNote: note, noAccessAt: undefined });
      record(c, 'dispatch_no_crew', 'not dispatched', 'no crew free', note);
    }
    setSelectedId(c.id);
  };

  /** Accepts the new route for a crew whose route was cut: it drives on from where it is. */
  const onReroute = (c: CallerReport) => {
    if (!graph) return;
    const m = missions.find((x) => x.id === viewCases[c.id]?.missionId);
    const state = m && crewStates.find((s) => s.mission?.id === m.id);
    if (!m || !state || state.status !== 'holding' || state.node == null) return;
    const plan = planLegs(graph, m.target, [{ id: state.crew.id, name: state.crew.name, node: state.node }], now)[0];
    if (!plan) {
      patchCase(c.id, { noAccessAt: now });
      record(c, 'reroute_no_access', `${state.crew.name} holding (route cut)`, 'no access by road');
      return;
    }
    const next = withReturn(graph, { ...m, legs: [...m.legs.filter((l) => l.startAt < now), plan.leg],
      lastStretchBlocked: plan.lastStretchBlocked, lastStretchM: plan.lastStretchM }, state.crew, streetById);
    setMissions((all) => all.map((x) => (x.id === m.id ? next : x)));
    patchCase(c.id, { noAccessAt: undefined });
    record(c, 'reroute', `${state.crew.name} holding (route cut)`, `${state.crew.name}, ETA ${mins(plan.leg.minutes)}, ${plan.leg.km.toFixed(1)} km`,
      'new route from the vehicle\'s position');
  };

  /** Redirects the crew that is on its way to `from` to another report. */
  const onReassign = (from: CallerReport, toReportId: string) => {
    if (!data || !graph) return;
    const to = data.callers.find((c) => c.id === toReportId);
    const m = missions.find((x) => x.id === viewCases[from.id]?.missionId);
    if (!to || !m) return;
    const k = candidatesFor(graph, [to.place.lon, to.place.lat], crewStates, now).find((x) => x.crew.id === m.crewId);
    if (k) { send(to, k); return; }
    patchCase(to.id, { noAccessAt: now });
    record(to, 'dispatch_no_access', 'not dispatched', 'no access by road', `tried to redirect the crew from ${shortLabel(from.id)}`);
  };

  // CONCEPT DEMO: report clusters at the time shown and the confirmed ones the next update would add.
  const conceptOn = !!data?.concept && layers.concept;
  const clusterStates = useMemo(() => (conceptOn && data?.concept ? clustersAt(data.concept, now, confirmations, asks) : []),
    [conceptOn, data, now, confirmations, asks]);
  const confirmedNow = useMemo(() => clusterStates.filter((c) => c.candidate && c.confirmedAt != null).map((c) => c.cluster.id),
    [clusterStates]);

  // "Update forecast": new observations since the forecast in force, and what the button would load.
  const fireProps = useMemo(() => (data ? data.fire.features.map((f) => f.properties) : []), [data, fireVersion]);
  const newObs = useMemo(() => (inForce ? newObservations(fireProps, inForce.run, now) : []), [fireProps, inForce, now]);
  const forecastOptions = useMemo(() => {
    if (!precomputed || !inForce) return { updateTo: null, rerunTo: null, blockedNote: null, newReports: 0 };
    const tz = data?.entry.timezone ?? 'UTC';
    const newest = precomputed.latest(now);
    const newer = newest && newest.issuedAt > inForce.run.issuedAt ? newest : null;
    const lastNew = newObs[newObs.length - 1];
    // Confirmed reports the newest forecast could start from but the one in force does not have.
    const usable = newest ? precomputed.usableReports(newest.issuedAt, confirmedNow) : [];
    const newReports = usable.filter((id) => !inForce.run.reports.includes(id)).length;
    const withReports = newest ? precomputed.withConfirmed(newest, confirmedNow) : null;
    let blockedNote: string | null = null;
    if (now > precomputed.lastIssueAt && (!newer || (lastNew && (newer.lastObsAt ?? 0) < lastNew.at))) {
      blockedNote = `No forecast can be issued after ${fmtTime(precomputed.lastIssueAt, tz)}: the weather data end 12 h later.`;
    } else if (!newObs.length && !newer && !newReports) {
      blockedNote = `The newest run is loaded; the next one can be issued at ${fmtTime(
        (precomputed.runs.find((r) => r.issuedAt > now)?.issuedAt ?? precomputed.lastIssueAt), tz)}.`;
    }
    const covers = newer && (!lastNew || (newer.lastObsAt ?? 0) >= lastNew.at);
    const updateTo = newObs.length ? (covers ? withReports : null) : newReports ? withReports : null;
    const rerunTo = !newObs.length && !newReports && newer ? withReports : null;
    return { updateTo, rerunTo, blockedNote, newReports };
  }, [precomputed, inForce, newObs, now, data, confirmedNow]);
  const previousLoad = useMemo(() => {
    if (!inForce) return null;
    const before = loads.filter((l) => l.at <= inForce.at && l !== inForce);
    return before[before.length - 1] ?? (precomputed?.first && inForce.run !== precomputed.first
      ? { seq: 0, at: precomputed.first.issuedAt, run: precomputed.first, kind: 'opening' as const } : null);
  }, [loads, inForce, precomputed]);

  const describeRun = (r: { issuedAt: number; from: string }) => `issued ${fmtTime(r.issuedAt, timeZone)} from ${r.from.replace(' (no new pass)', '')}`;
  const onUpdateForecast = async (kind: 'update' | 'rerun') => {
    if (!source || !data || !inForce) return;
    setForecastBusy(true);
    const at = now;
    try {
      const run = await source.run({ scenario: data.entry.id, at, kind, reports: conceptOn ? confirmedNow : [] });
      if (!run || run.id === inForce.run.id) return;
      if (!data.fire.features.some((f) => f.properties.run_id === run.id)) {
        data.fire.features.push(...run.features);
        setFireVersion((v) => v + 1);
      }
      const samePerimeter = run.lastObsAt === inForce.run.lastObsAt && run.from.replace(' (no new pass)', '') === inForce.run.from.replace(' (no new pass)', '');
      const withReports = run.reports.length
        ? `with ${run.reports.length} confirmed report${run.reports.length > 1 ? 's' : ''} (CONCEPT DEMO)` : '';
      const label = (samePerimeter && !withReports ? 'same perimeter, new weather' : withReports) || undefined;
      const load: ForecastLoad = { seq: ++loadSeq.current, at, run, kind, label };
      setLoads((all) => loadAt(all, load));
      const twelve = (r: typeof run) => r.contours.find((c) => c.horizon === 12)?.areaKm2;
      record({ id: 'forecast' }, 'update_forecast', describeRun(inForce.run), describeRun(run),
        [kind === 'rerun' ? 'Re-run with current weather' : [newObs.length ? `${newObs.length} new observation${newObs.length === 1 ? '' : 's'}` : '',
          forecastOptions.newReports ? `${forecastOptions.newReports} confirmed report${forecastOptions.newReports === 1 ? '' : 's'}` : ''].filter(Boolean).join(', '),
          label, run.source === 'live' ? 'live model' : 'precomputed', run.sourceNote,
          twelve(run) != null && twelve(inForce.run) != null ? `+12 h ${twelve(run)!.toFixed(1)} km² (was ${twelve(inForce.run)!.toFixed(1)})` : '',
        ].filter(Boolean).join('; '));
    } finally {
      setForecastBusy(false);
    }
  };

  const onConfirmReport = (clusterId: string) => {
    const c = clusterStates.find((x) => x.cluster.id === clusterId);
    if (!c) return;
    setConfirmations((m) => new Map(m).set(clusterId, now));
    record({ id: clusterId, synthetic: true }, 'confirm_report', `REPORTED (unconfirmed), P ${c.p.toFixed(2)}, ${c.sources} sources`,
      'confirmed: used in the next forecast update', CONCEPT_LABEL);
  };

  /** Asks the nearest crew, then a person who reported the place, whether the fire is still there (MOCK). */
  const onAsk = (clusterId: string) => {
    const c = clusterStates.find((x) => x.cluster.id === clusterId);
    if (!c || !data?.concept) return;
    const target = nextAskTarget(c, crewStates.map((k) => ({ id: k.crew.id, name: k.crew.name, position: k.position, busy: k.status === 'holding' })));
    if (!target) return;
    const { channel, language, reportId, ...who } = target;
    const ask: ConfirmationAsk = {
      id: `ask-${++askSeq.current}`, cluster_id: clusterId, report_id: reportId, target: who, channel, language,
      question_code: 'FIRE_STILL_THERE', sent_at: now, expires_at: now + ASK_EXPIRES_MIN * 60000, mock: true,
    };
    const all = data.concept.records.filter((r) => c.cluster.reports.includes(r.id));
    const fireThere = all.some((r) => r._truth === 'fire');
    const onSite = all.find((r) => r.id === reportId)?.observer_distance === 'on_site';
    const answer = mockAnswer(ask, fireThere, who.kind === 'crew' || onSite);
    // Asking again earlier on the timeline replaces the later requests for this place.
    setAsks((list) => [...list.filter((a) => !(a.ask.cluster_id === clusterId && a.ask.sent_at > now)), { ask, answer }]);
    record({ id: clusterId, synthetic: true }, 'ask_confirmation', `P ${c.p.toFixed(2)}`,
      `asked ${who.name} (${who.kind}, ${channel}, ${(who.distance_m / 1000).toFixed(1)} km)`, 'MOCK: no message is sent; CONCEPT DEMO');
  };

  const changeOnScene = (value: number) => {
    const v = Math.min(480, Math.max(5, Math.round(value) || DEFAULT_ON_SCENE_MIN));
    if (v === onSceneMin) return;
    record({ id: 'settings' }, 'settings', `on-scene time ${onSceneMin} min`, `on-scene time ${v} min`, 'applies to crews dispatched from now on');
    setOnSceneMin(v);
  };

  // Time-bar marks: when each forecast was issued (or, without updates, when the initial horizons are reached).
  const marks = useMemo(() => {
    if (!data) return [];
    const fc = data.fire.features.map((f) => f.properties).filter((p) => p.kind === 'forecast');
    if (!fc.some((p) => p.set === 'update')) {
      return fc.map((p) => ({ t: p.t, label: `+${p.horizon_hours} h`, colour: HORIZON_COLOURS[p.rank ?? 0] as string }));
    }
    // With precomputed forecasts: when the operator loaded one. Otherwise when each update was issued.
    // Only up to now: a tick for a later forecast would announce a satellite pass in advance.
    const times = precomputed ? loads.map((l) => l.at)
      : [...new Set(fc.filter((p) => p.set === 'update').map((p) => p.issue_t!))];
    return [...new Set(times)].filter((t) => t <= now).sort((a, b) => a - b)
      .map((t, i) => ({ t, label: i === 0 ? (precomputed ? 'forecast loaded' : 'forecast issued') : '', colour: '#fde047' }));
  }, [data, now, precomputed, loads]);

  // Routes and vehicles on the map: the leg each crew is driving at the time shown.
  const routes = useMemo(() => crewStates.flatMap((s) => {
    const m = s.mission;
    if (!m) return [];
    if (s.status === 'returning' && m.back) return [{ reportId: m.reportId, edgeIds: m.back.spans.map((x) => x.edgeId), cut: false }];
    if (s.status !== 'en_route' && s.status !== 'holding') return [];
    const leg = [...m.legs].reverse().find((l) => l.startAt <= now) ?? m.legs[0];
    return [{ reportId: m.reportId, edgeIds: leg.spans.map((x) => x.edgeId), cut: s.status === 'holding' }];
  }), [crewStates, now]);
  const vehicles: Vehicle[] = useMemo(() => crewStates.filter((s) => s.status !== 'available').map((s) => ({
    id: s.crew.id, name: s.crew.name, status: s.status, position: s.position,
    label: s.status === 'en_route' ? `ETA ${mins(s.etaMin ?? 0)}` : s.status === 'returning' ? `back in ${mins(s.etaMin ?? 0)}`
      : s.status === 'holding' ? 'route cut' : 'on scene',
  })), [crewStates]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ahead = useMemo(() => (data ? aheadContours(data.fire.features, now, forecastRunId) : []), [data, now, forecastRunId, fireVersion]);
  const stages = useMemo(() => Object.fromEntries(Object.entries(viewCases).map(([id, cs]) => [id, cs.stage])), [viewCases]);

  const syntheticLayers = data ? ([['caller reports', data.callersMeta], ['street access', data.streetsMeta],
    ['fire front', data.fireMeta]] as const).filter(([, m]) => m.synthetic === true).map(([n]) => n) : [];
  const modelStreets = !!data && fileKind(data.streetsMeta) === 'model';

  const scenarioSelect = (
    <select value={scenarioId ?? ''} onChange={(e) => { setSelectedId(null); setScenarioId(e.target.value); }}
      aria-label="Scenario" className="rounded bg-ink-800 px-2 py-1 text-sm text-ink-50">
      {scenarios.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
    </select>
  );
  const callerList = data && (
    <CallerList callers={callers} streets={data.streets.features} now={now} timeZone={timeZone}
      synthetic={data.callersMeta.synthetic === true} selectedId={selected?.id ?? null}
      cases={viewCases} cardCrews={cardCrews} candidates={candidates} awaiting={awaiting} labelOf={labelOf} ahead={ahead}
      canRoute={data.responders.length > 0} onSelect={setSelectedId} onTake={onTake} onConfirm={onConfirm}
      onDispatch={onDispatch} onReroute={onReroute} onReassign={onReassign} />
  );
  const sidePanel = data && (
    <SidePanel data={data} now={now} timeZone={timeZone} layers={layers} mode={mode} forecastRunId={forecastRunId}
      conceptPanel={conceptOn && data.concept ? (
        <ConceptPanel clusters={clusterStates} inForecast={inForce?.run.reports ?? []} now={now} timeZone={timeZone}
          reportsUntil={Date.parse(data.concept.metadata.window_end)} onConfirm={onConfirmReport} onAsk={onAsk}
          scores={data.concept.scores.filter((x) => Date.parse(x.next_pass_at) <= now)} />
      ) : null}
      onToggle={(k) => setLayers((l) => ({ ...l, [k]: !l[k] }))}
      crewStates={crewStates} labelOf={shortLabel} onSceneMin={onSceneMin} onSceneChange={changeOnScene}
      onFocusCrew={(s) => setFocus({ lon: s.position[0], lat: s.position[1], key: Date.now() })} />
  );
  const decisionLog = data && (
    <DecisionLog decisions={decisions} scenarioId={data.entry.id} timeZone={timeZone}
      labelOf={(id) => (id === 'settings' ? 'Crews' : id === 'forecast' ? 'Forecast'
        : id.startsWith('concept-cluster') ? `Fire report ${id.slice(-2)} (concept demo)` : labelOf(id))} />
  );
  const mapProps = data && {
    data, now, layers, selectedId: selected?.id ?? null, nearIds, stages, routes, vehicles, focus, urgencyOf, onSelect: setSelectedId, mode,
    forecastRunId, streetsVersion, fireVersion, concept: clusterStates,
  };
  // CONCEPT DEMO: the full label stays on the map while the synthetic reports are shown.
  const conceptBanner = conceptOn && (
    <div data-concept-banner className="pointer-events-none absolute bottom-8 left-2 z-10 max-w-[calc(100%-140px)] rounded border border-dashed border-violet-400 bg-ink-900/85 px-2 py-1 text-[11px] font-bold text-violet-200">
      {CONCEPT_LABEL}
    </div>
  );
  const forecastControl = (compact: boolean) => precomputed && (
    <ForecastControl load={inForce} previous={previousLoad} newObs={newObs} updateTo={forecastOptions.updateTo}
      rerunTo={forecastOptions.rerunTo} blockedNote={forecastOptions.blockedNote} sourceKind={source?.kind ?? 'precomputed'}
      newReports={forecastOptions.newReports}
      busy={forecastBusy} timeZone={timeZone} compact={compact} onUpdate={onUpdateForecast} />
  );
  // With one tabbed panel, picking a caller (on the map or by a deep link) shows its card.
  useEffect(() => { if (medium && selectedId) setTab('reports'); }, [medium, selectedId]);

  /** Jump to the rehearsed scene: its time, its call selected and centred, the clock paused. */
  const openDemo = () => {
    const demo = data?.entry.demo;
    if (!demo) return;
    setPlaying(false);
    setTab('reports');
    const t = Date.parse(demo.t);
    setNow(t);
    // The scene starts as if the forecast had been updated at every pass until then.
    if (precomputed) {
      const history = historyLoads(precomputed, t, loadSeq.current + 1);
      loadSeq.current += history.length;
      setLoads(history);
    }
    const c = data!.callers.find((x) => x.id === demo.call);
    if (c) { setSelectedId(c.id); setFocus({ lon: c.place.lon, lat: c.place.lat, key: Date.now() }); }
  };
  const demoButton = (compact: boolean) => data?.entry.demo && (
    <button data-demo onClick={openDemo} title={data.entry.demo.note ?? 'Open the rehearsed demo scene'}
      className={`shrink-0 rounded border border-sky-500 font-bold text-sky-300 hover:bg-sky-900 ${compact ? 'px-1.5 py-0.5 text-[11px]' : 'px-2 py-1 text-xs'}`}>
      Demo
    </button>
  );

  const modeSwitch = (compact: boolean) => (
    <div role="group" aria-label="Map detail" className={`flex shrink-0 overflow-hidden rounded border border-ink-600 ${compact ? 'text-[11px]' : 'text-xs'}`}>
      {(['simple', 'detailed'] as const).map((m) => (
        <button key={m} data-mode={m} aria-pressed={mode === m} onClick={() => setMode(m)}
          className={`${compact ? 'h-8 px-2' : 'px-2.5 py-1'} font-bold ${mode === m ? 'bg-sky-500 text-ink-950' : 'text-ink-200 hover:bg-ink-800'}`}>
          {m === 'simple' ? 'Simple' : 'Detailed'}
        </button>
      ))}
    </div>
  );

  if (phone) {
    const DRAWER_OPEN = 0.5;                 // share of the map the open drawer (portrait) may cover
    const SIDE_PANEL_PX = 360;               // landscape: panel from the right, never more than half the width
    const TAB_BAR_PX = 44;
    const main = mainRef.current;
    const sideWidth = Math.min(SIDE_PANEL_PX, (main?.clientWidth ?? window.innerWidth) * 0.5);
    const insetBottom = landscape ? 0 : drawer ? (main?.clientHeight ?? 0) * DRAWER_OPEN : TAB_BAR_PX;
    const insetRight = landscape && drawer ? sideWidth : 0;
    const tabs = [
      ['reports', `Reports (${callers.length})`], ['layers', 'Layers'],
      ['log', `${landscape ? 'Log' : 'Decision log'} (${decisions.length})`],
    ] as const;
    const tabButtons = tabs.map(([k, label]) => (
      <button key={k} role="tab" aria-selected={drawer === k} data-drawer-tab={k}
        onClick={() => setDrawer(drawer === k ? null : k)}
        className={`${landscape ? 'h-9 whitespace-nowrap rounded px-3' : 'flex-1 px-1'} ${drawer === k
          ? (landscape ? 'bg-ink-700 text-ink-50' : 'border-b-2 border-sky-400 text-ink-50') : 'text-ink-400'}`}>
        {label}{drawer === k ? (landscape ? ' ✕' : ' ▾') : ''}
      </button>
    ));
    return (
      <div className="flex flex-col" style={{ height: '100dvh' }} data-layout={landscape ? 'phone-landscape' : 'phone'}>
        <header className={`flex items-center gap-x-2 gap-y-1 border-b border-ink-700 bg-ink-900 px-2 ${landscape ? 'h-10 flex-nowrap' : 'flex-wrap py-1.5'}`}>
          <h1 className="whitespace-nowrap text-sm font-bold">Nature Shield</h1>
          {modeSwitch(true)}
          {demoButton(true)}
          {syntheticLayers.length > 0 && <span className="synthetic-tag">SYNTHETIC calls</span>}
          {conceptOn && <span className="concept-tag" title={CONCEPT_LABEL} data-concept-header>CONCEPT DEMO</span>}
          {modelStreets && <span className="model-tag truncate">{modelLabel(data!.streetsMeta)} streets</span>}
          {landscape && <div className="ml-auto flex shrink-0 gap-1 text-xs font-bold" role="tablist">{tabButtons}</div>}
        </header>
        {error && <p className="p-4 text-rose-400">Could not load the scenario: {error}</p>}
        {!data && !error && <p className="p-4 text-ink-400">Loading scenario…</p>}
        {data && mapProps && (
          <>
            <main ref={mainRef} className="relative min-h-0 flex-1 overflow-hidden">
              <MapView {...mapProps} insetBottom={insetBottom} insetRight={insetRight} fitFire />
              {forecastControl(true)}
              {conceptBanner}
              <div data-drawer={drawer ?? 'closed'}
                className={landscape
                  ? `absolute inset-y-0 right-0 z-10 flex flex-col border-l border-ink-600 bg-ink-900 shadow-2xl ${drawer ? '' : 'hidden'}`
                  : 'absolute inset-x-0 bottom-0 z-10 flex flex-col rounded-t-xl border-t border-ink-600 bg-ink-900 shadow-2xl'}
                style={landscape ? { width: sideWidth } : { height: drawer ? `${DRAWER_OPEN * 100}%` : TAB_BAR_PX }}>
                {!landscape && (
                  <div className="flex shrink-0 text-xs font-bold" style={{ height: TAB_BAR_PX }} role="tablist">{tabButtons}</div>
                )}
                {drawer && (
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    {drawer === 'reports' && callerList}
                    {drawer === 'layers' && (
                      <>
                        <div className="flex flex-wrap items-center gap-2 border-b border-ink-700 p-3 text-xs text-ink-400">
                          <label>Scenario {scenarioSelect}</label>
                          <label>Operator{' '}
                            <input value={operator} onChange={(e) => setOperator(e.target.value)} aria-label="Operator name"
                              className="w-28 rounded bg-ink-800 px-2 py-1 text-sm text-ink-50" />
                          </label>
                        </div>
                        {sidePanel}
                      </>
                    )}
                    {drawer === 'log' && decisionLog}
                  </div>
                )}
              </div>
            </main>
            <TimeBar compact thin={landscape} start={start} end={end} now={now} playing={playing} speed={speed} timeZone={timeZone} marks={marks}
              onSeek={setNow} onPlay={(p) => { if (p && now >= end) setNow(start); setPlaying(p); }} onSpeed={setSpeed} />
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className={`flex flex-wrap items-center border-b border-ink-700 bg-ink-900 px-3 py-2 gap-y-1.5 ${roomy ? 'gap-x-3' : 'gap-x-2'}`}>
        <h1 className="whitespace-nowrap text-base font-bold">Nature Shield{roomy && <span className="font-normal text-ink-400"> · Operator screen</span>}</h1>
        <label className="text-xs text-ink-400">
          Scenario{' '}
          {scenarioSelect}
        </label>
        {modeSwitch(false)}
        {demoButton(false)}
        {syntheticLayers.length > 0 && (
          <span className="synthetic-tag whitespace-nowrap" style={{ fontSize: 11, padding: '3px 8px' }}>
            SYNTHETIC {roomy ? syntheticLayers.join(' and ') : 'calls'}
          </span>
        )}
        {conceptOn && (
          <span className="concept-tag" style={{ fontSize: 11, padding: '3px 8px' }} title={CONCEPT_LABEL} data-concept-header>
            CONCEPT DEMO
          </span>
        )}
        {modelStreets && (
          <span className="model-tag whitespace-nowrap" style={{ fontSize: 11, padding: '3px 8px' }}
            title="Street access is computed from the forecast and satellite data, not a road survey">
            {modelLabel(data!.streetsMeta)} {roomy ? 'street access (not a road survey)' : 'streets'}
          </span>
        )}
        <label className="ml-auto whitespace-nowrap text-xs text-ink-400">
          Operator{' '}
          <input value={operator} onChange={(e) => setOperator(e.target.value)} aria-label="Operator name"
            className="w-28 rounded bg-ink-800 px-2 py-1 text-sm text-ink-50" />
        </label>
        {offlineReady && (
          <span data-offline-ready className="whitespace-nowrap text-xs text-emerald-400"
            title="Page, scenario data and the packaged basemap are stored in this browser: the screen opens without a network.">
            ✓ Offline ready
          </span>
        )}
        {roomy && (
          <span className="whitespace-nowrap text-xs text-ink-400" title="Decision-support prototype. A human confirms every decision.">
            A human confirms every decision
          </span>
        )}
      </header>

      {error && <p className="p-4 text-rose-400">Could not load the scenario: {error}</p>}
      {!data && !error && <p className="p-4 text-ink-400">Loading scenario…</p>}
      {data && mapProps && (
        <>
          {medium ? (
            // One panel with three tabs; the map gets the rest (at least 55 % of the width from 768 px).
            <div className="flex min-h-0 flex-1" data-layout-size="tabs">
              <aside className="flex w-[330px] shrink-0 flex-col border-r border-ink-700 bg-ink-900" style={{ maxWidth: '43vw' }}>
                <div className="flex border-b border-ink-700 text-xs font-bold uppercase tracking-wider" role="tablist">
                  {(['reports', 'overview', 'log'] as const).map((k) => (
                    <button key={k} onClick={() => setTab(k)} data-tab={k} role="tab" aria-selected={tab === k}
                      className={`flex-1 whitespace-nowrap px-2 py-2.5 ${tab === k ? 'bg-ink-800 text-ink-50' : 'text-ink-400 hover:bg-ink-850'}`}>
                      {k === 'reports' ? `Reports (${callers.length})` : k === 'overview' ? 'Layers & crews' : `Log (${decisions.length})`}
                    </button>
                  ))}
                </div>
                <div className="min-h-0 flex-1">{tab === 'reports' ? callerList : tab === 'overview' ? sidePanel : decisionLog}</div>
              </aside>
              <main className="relative min-w-0 flex-1">
                <MapView {...mapProps} />
                {forecastControl(false)}
                {conceptBanner}
              </main>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1">
              <aside className={`${roomy ? 'w-[360px]' : 'w-[300px]'} shrink-0 border-r border-ink-700 bg-ink-900`}>{callerList}</aside>
              <main className="relative min-w-0 flex-1">
                <MapView {...mapProps} />
                {forecastControl(false)}
                {conceptBanner}
              </main>
              <aside className={`flex ${roomy ? 'w-[310px]' : 'w-[260px]'} shrink-0 flex-col border-l border-ink-700 bg-ink-900`}>
                <div className="flex border-b border-ink-700 text-xs font-bold uppercase tracking-wider">
                  {(['overview', 'log'] as const).map((k) => (
                    <button key={k} onClick={() => setTab(k)} data-tab={k}
                      className={`flex-1 px-3 py-2 ${(tab === k || (k === 'overview' && tab === 'reports')) ? 'bg-ink-800 text-ink-50' : 'text-ink-400 hover:bg-ink-850'}`}>
                      {k === 'overview' ? 'Overview' : `${roomy ? 'Decision log' : 'Log'} (${decisions.length})`}
                    </button>
                  ))}
                </div>
                <div className="min-h-0 flex-1">{tab === 'log' ? decisionLog : sidePanel}</div>
              </aside>
            </div>
          )}
          <TimeBar start={start} end={end} now={now} playing={playing} speed={speed} timeZone={timeZone} marks={marks}
            onSeek={setNow} onPlay={(p) => { if (p && now >= end) setNow(start); setPlaying(p); }} onSpeed={setSpeed} />
        </>
      )}
    </div>
  );
}
