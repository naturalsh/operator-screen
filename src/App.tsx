import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HORIZON_COLOURS, URGENCY_LABEL, fileKind, loadIndex, loadScenario, modelLabel, streetsNear, visibleCallers } from './data';
import { buildGraph, cutStreets, planRoute, type RoutePlan } from './routing';
import type { CallerReport, Decision, ScenarioData, ScenarioEntry, StreetFeature, Urgency } from './types';
import { CallerList, NEAR_RADIUS_M, type CaseState, type RouteCheck } from './components/CallerList';
import { DecisionLog } from './components/DecisionLog';
import { MapView, type LayerKey } from './components/MapView';
import { SidePanel } from './components/SidePanel';
import { TimeBar } from './components/TimeBar';
import { useMediaQuery } from './useMediaQuery';

const TICK_MS = 100;

/** `?scenario=<id>&t=<ISO time>&call=<report id>&basemap=offline` deep-links to a moment (handy for rehearsals). */
const params = new URLSearchParams(location.search);

const describeRoute = (r: RoutePlan) => `${r.responderName}, ${Math.max(1, Math.round(r.minutes))} min, ${r.km.toFixed(1)} km`;

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
    forecast: true, initial: false, observed: true, streets: true, callers: true, crews: true,
  });
  const [operator, setOperator] = useState('operator-1');
  const [cases, setCases] = useState<Record<string, CaseState>>({});
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [tab, setTab] = useState<'overview' | 'log'>('overview');
  // Phone layout (below 768 px): full-screen map, a bottom drawer with three tabs, a fixed time bar.
  const phone = useMediaQuery('(max-width: 767px)');
  const [drawer, setDrawer] = useState<'reports' | 'layers' | 'log' | null>(null);
  const mainRef = useRef<HTMLElement>(null);

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
    setDecisions([]);
    loadScenario(entry).then((d) => {
      const t = Date.parse(params.get('t') ?? '') || Date.parse(entry.initial ?? entry.start);
      setNow(Math.min(Math.max(t, Date.parse(entry.start)), Date.parse(entry.end)));
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
  const streetById = useMemo(
    () => new Map<string, StreetFeature>((data?.streets.features ?? []).map((s) => [s.properties.id, s])), [data]);

  const urgencyOf = useCallback((c: CallerReport) => cases[c.id]?.urgency ?? c.urgency, [cases]);
  const callers = useMemo(() => (data ? visibleCallers(data.callers, now, urgencyOf) : []), [data, now, urgencyOf]);
  const selected = callers.find((c) => c.id === selectedId) ?? null;
  const nearIds = useMemo(
    () => (data && selected ? streetsNear(data.streets.features, selected, NEAR_RADIUS_M).map((n) => n.street.properties.id) : []),
    [data, selected]);

  // Is each dispatched route still passable at the current time? If not, what would replace it?
  const routeChecks = useMemo(() => {
    const out: Record<string, RouteCheck> = {};
    if (!data || !graph) return out;
    for (const c of data.callers) {
      const route = cases[c.id]?.route;
      if (!route) continue;
      const cut = cutStreets(route, now, streetById);
      out[c.id] = { cut, alternative: cut.length ? planRoute(graph, c, data.responders, now) : null };
    }
    return out;
  }, [data, graph, cases, now, streetById]);

  const record = useCallback((c: CallerReport, action: Decision['action'], previous: string | null,
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
    record(c, 'confirm_urgency', `${URGENCY_LABEL[c.urgency]} (agent suggestion)`, URGENCY_LABEL[urgency],
      urgency === c.urgency ? 'suggestion confirmed' : 'suggestion changed by the operator');
  };
  const onDispatch = (c: CallerReport) => {
    if (!data || !graph) return;
    const route = planRoute(graph, c, data.responders, now);
    if (route) {
      patchCase(c.id, { stage: 'dispatched', route, noAccessAt: undefined });
      record(c, 'dispatch', 'not dispatched', describeRoute(route),
        route.lastStretchBlocked ? `caller's street is blocked: crew stops ${Math.round(route.lastStretchM)} m away` : undefined);
    } else {
      patchCase(c.id, { noAccessAt: now });
      record(c, 'dispatch_no_access', 'not dispatched', 'no access by road', 'every route is cut by blocked streets');
    }
    setSelectedId(c.id);
  };
  const onReroute = (c: CallerReport) => {
    const old = cases[c.id]?.route;
    const check = routeChecks[c.id];
    if (!old || !check) return;
    if (check.alternative) {
      patchCase(c.id, { route: check.alternative, noAccessAt: undefined });
      record(c, 'reroute', describeRoute(old), describeRoute(check.alternative),
        `route cut: ${check.cut.length} street(s) blocked`);
    } else {
      patchCase(c.id, { noAccessAt: now });
      record(c, 'reroute_no_access', describeRoute(old), 'no access by road');
    }
  };

  // Time-bar marks: when each forecast was issued (or, without updates, when the initial horizons are reached).
  const marks = useMemo(() => {
    if (!data) return [];
    const fc = data.fire.features.map((f) => f.properties).filter((p) => p.kind === 'forecast');
    if (!fc.some((p) => p.set === 'update')) {
      return fc.map((p) => ({ t: p.t, label: `+${p.horizon_hours} h`, colour: HORIZON_COLOURS[p.rank ?? 0] as string }));
    }
    return [...new Set(fc.filter((p) => p.set === 'update').map((p) => p.issue_t!))].sort((a, b) => a - b)
      .map((t, i) => ({ t, label: i === 0 ? 'forecast issued' : '', colour: '#fde047' }));
  }, [data]);

  const routes = useMemo(() => Object.entries(cases).filter(([, cs]) => cs.route).map(([id, cs]) => ({
    reportId: id, edgeIds: cs.route!.edgeIds, cut: (routeChecks[id]?.cut.length ?? 0) > 0,
  })), [cases, routeChecks]);
  const stages = useMemo(() => Object.fromEntries(Object.entries(cases).map(([id, cs]) => [id, cs.stage])), [cases]);

  const syntheticLayers = data ? ([['caller reports', data.callersMeta], ['street access', data.streetsMeta],
    ['fire front', data.fireMeta]] as const).filter(([, m]) => m.synthetic === true).map(([n]) => n) : [];
  const modelStreets = !!data && fileKind(data.streetsMeta) === 'model';
  const timeZone = data?.entry.timezone ?? 'UTC';
  const labelOf = (id: string) => data?.callers.find((c) => c.id === id)?.place.label ?? id;

  const scenarioSelect = (
    <select value={scenarioId ?? ''} onChange={(e) => { setSelectedId(null); setScenarioId(e.target.value); }}
      aria-label="Scenario" className="rounded bg-ink-800 px-2 py-1 text-sm text-ink-50">
      {scenarios.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
    </select>
  );

  if (phone) {
    const DRAWER_OPEN = 0.5;                 // share of the map area the open drawer covers
    const TAB_BAR_PX = 44;
    const inset = () => (drawer ? (mainRef.current?.clientHeight ?? 0) * DRAWER_OPEN : TAB_BAR_PX);
    const tabs = [
      ['reports', `Reports (${callers.length})`], ['layers', 'Layers'], ['log', `Decision log (${decisions.length})`],
    ] as const;
    return (
      <div className="flex flex-col" style={{ height: '100dvh' }} data-layout="phone">
        <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-ink-700 bg-ink-900 px-2 py-1.5">
          <h1 className="whitespace-nowrap text-sm font-bold">Nature Shield</h1>
          {syntheticLayers.length > 0 && <span className="synthetic-tag">SYNTHETIC calls</span>}
          {modelStreets && <span className="model-tag">{modelLabel(data!.streetsMeta)} streets</span>}
        </header>
        {error && <p className="p-4 text-rose-400">Could not load the scenario: {error}</p>}
        {!data && !error && <p className="p-4 text-ink-400">Loading scenario…</p>}
        {data && (
          <>
            <main ref={mainRef} className="relative min-h-0 flex-1 overflow-hidden">
              <MapView data={data} now={now} layers={layers} selectedId={selected?.id ?? null}
                nearIds={nearIds} stages={stages} routes={routes} urgencyOf={urgencyOf} onSelect={setSelectedId}
                bottomInset={inset()} fitFire />
              <div className="absolute inset-x-0 bottom-0 z-10 flex flex-col rounded-t-xl border-t border-ink-600 bg-ink-900 shadow-2xl"
                style={{ height: drawer ? `${DRAWER_OPEN * 100}%` : TAB_BAR_PX }} data-drawer={drawer ?? 'closed'}>
                <div className="flex shrink-0 text-xs font-bold" style={{ height: TAB_BAR_PX }} role="tablist">
                  {tabs.map(([k, label]) => (
                    <button key={k} role="tab" aria-selected={drawer === k} data-drawer-tab={k}
                      onClick={() => setDrawer(drawer === k ? null : k)}
                      className={`flex-1 px-1 ${drawer === k ? 'border-b-2 border-sky-400 text-ink-50' : 'text-ink-400'}`}>
                      {label}{drawer === k ? ' ▾' : ''}
                    </button>
                  ))}
                </div>
                {drawer && (
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    {drawer === 'reports' && (
                      <CallerList callers={callers} streets={data.streets.features} now={now} timeZone={timeZone}
                        synthetic={data.callersMeta.synthetic === true} selectedId={selected?.id ?? null}
                        cases={cases} routeChecks={routeChecks} canRoute={data.responders.length > 0}
                        onSelect={setSelectedId} onTake={onTake} onConfirm={onConfirm} onDispatch={onDispatch} onReroute={onReroute} />
                    )}
                    {drawer === 'layers' && (
                      <>
                        <div className="flex flex-wrap items-center gap-2 border-b border-ink-700 p-3 text-xs text-ink-400">
                          <label>Scenario {scenarioSelect}</label>
                          <label>Operator{' '}
                            <input value={operator} onChange={(e) => setOperator(e.target.value)} aria-label="Operator name"
                              className="w-28 rounded bg-ink-800 px-2 py-1 text-sm text-ink-50" />
                          </label>
                        </div>
                        <SidePanel data={data} now={now} timeZone={timeZone} layers={layers}
                          onToggle={(k) => setLayers((l) => ({ ...l, [k]: !l[k] }))} />
                      </>
                    )}
                    {drawer === 'log' && (
                      <DecisionLog decisions={decisions} scenarioId={data.entry.id} timeZone={timeZone} labelOf={labelOf} />
                    )}
                  </div>
                )}
              </div>
            </main>
            <TimeBar compact start={start} end={end} now={now} playing={playing} speed={speed} timeZone={timeZone} marks={marks}
              onSeek={setNow} onPlay={(p) => { if (p && now >= end) setNow(start); setPlaying(p); }} onSpeed={setSpeed} />
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-ink-700 bg-ink-900 px-3 py-2">
        <h1 className="whitespace-nowrap text-base font-bold">Nature Shield <span className="font-normal text-ink-400">· Operator screen</span></h1>
        <label className="text-xs text-ink-400">
          Scenario{' '}
          {scenarioSelect}
        </label>
        {syntheticLayers.length > 0 && (
          <span className="synthetic-tag" style={{ fontSize: 11, padding: '3px 8px' }}>
            SYNTHETIC {syntheticLayers.join(' and ')}
          </span>
        )}
        {modelStreets && (
          <span className="model-tag" style={{ fontSize: 11, padding: '3px 8px' }}>
            {modelLabel(data!.streetsMeta)} street access (not a road survey)
          </span>
        )}
        <label className="ml-auto whitespace-nowrap text-xs text-ink-400">
          Operator{' '}
          <input value={operator} onChange={(e) => setOperator(e.target.value)} aria-label="Operator name"
            className="w-28 rounded bg-ink-800 px-2 py-1 text-sm text-ink-50" />
        </label>
        <span className="truncate text-xs text-ink-400" title="Decision-support prototype. A human confirms every decision.">
          A human confirms every decision
        </span>
      </header>

      {error && <p className="p-4 text-rose-400">Could not load the scenario: {error}</p>}
      {!data && !error && <p className="p-4 text-ink-400">Loading scenario…</p>}
      {data && (
        <>
          <div className="flex min-h-0 flex-1">
            <aside className="w-[360px] shrink-0 border-r border-ink-700 bg-ink-900">
              <CallerList callers={callers} streets={data.streets.features} now={now} timeZone={timeZone}
                synthetic={data.callersMeta.synthetic === true} selectedId={selected?.id ?? null}
                cases={cases} routeChecks={routeChecks} canRoute={data.responders.length > 0}
                onSelect={setSelectedId} onTake={onTake} onConfirm={onConfirm} onDispatch={onDispatch} onReroute={onReroute} />
            </aside>
            <main className="relative min-w-0 flex-1">
              <MapView data={data} now={now} layers={layers} selectedId={selected?.id ?? null}
                nearIds={nearIds} stages={stages} routes={routes} urgencyOf={urgencyOf} onSelect={setSelectedId} />
            </main>
            <aside className="flex w-[310px] shrink-0 flex-col border-l border-ink-700 bg-ink-900">
              <div className="flex border-b border-ink-700 text-xs font-bold uppercase tracking-wider">
                {(['overview', 'log'] as const).map((k) => (
                  <button key={k} onClick={() => setTab(k)} data-tab={k}
                    className={`flex-1 px-3 py-2 ${tab === k ? 'bg-ink-800 text-ink-50' : 'text-ink-400 hover:bg-ink-850'}`}>
                    {k === 'overview' ? 'Overview' : `Decision log (${decisions.length})`}
                  </button>
                ))}
              </div>
              <div className="min-h-0 flex-1">
                {tab === 'overview'
                  ? <SidePanel data={data} now={now} timeZone={timeZone} layers={layers}
                      onToggle={(k) => setLayers((l) => ({ ...l, [k]: !l[k] }))} />
                  : <DecisionLog decisions={decisions} scenarioId={data.entry.id} timeZone={timeZone} labelOf={labelOf} />}
              </div>
            </aside>
          </div>
          <TimeBar start={start} end={end} now={now} playing={playing} speed={speed} timeZone={timeZone} marks={marks}
            onSeek={setNow} onPlay={(p) => { if (p && now >= end) setNow(start); setPlaying(p); }} onSpeed={setSpeed} />
        </>
      )}
    </div>
  );
}
