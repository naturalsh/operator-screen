import { useEffect, useMemo, useState } from 'react';
import { fileKind, loadIndex, loadScenario, streetsNear, visibleCallers } from './data';
import type { ScenarioData, ScenarioEntry } from './types';
import { CallerList, NEAR_RADIUS_M } from './components/CallerList';
import { MapView, type LayerKey } from './components/MapView';
import { SidePanel } from './components/SidePanel';
import { TimeBar } from './components/TimeBar';

const TICK_MS = 100;

/** `?scenario=<id>&t=<ISO time>&call=<report id>` deep-links to a moment (handy for rehearsals). */
const params = new URLSearchParams(location.search);

export function App() {
  const [scenarios, setScenarios] = useState<ScenarioEntry[]>([]);
  const [scenarioId, setScenarioId] = useState<string | null>(params.get('scenario'));
  const [data, setData] = useState<ScenarioData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(params.get('call'));
  const [layers, setLayers] = useState<Record<LayerKey, boolean>>({ forecast: true, observed: true, streets: true, callers: true });

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

  const callers = useMemo(() => (data ? visibleCallers(data.callers, now) : []), [data, now]);
  const selected = callers.find((c) => c.id === selectedId) ?? null;
  const nearIds = useMemo(
    () => (data && selected ? streetsNear(data.streets.features, selected, NEAR_RADIUS_M).map((n) => n.street.properties.id) : []),
    [data, selected]);
  const marks = useMemo(() => (data ? data.fire.features.filter((f) => f.properties.kind === 'forecast').map((f) => ({
    t: f.properties.t, label: `+${f.properties.horizon_hours} h`,
    colour: f.properties.horizon_hours === 8 ? '#fde047' : f.properties.horizon_hours === 20 ? '#fb923c' : '#f97316',
  })) : []), [data]);

  const syntheticLayers = data ? ([['caller reports', data.callersMeta], ['street access', data.streetsMeta],
    ['fire front', data.fireMeta]] as const).filter(([, m]) => m.synthetic === true).map(([n]) => n) : [];
  const modelStreets = !!data && fileKind(data.streetsMeta) === 'model';
  const timeZone = data?.entry.timezone ?? 'UTC';

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-ink-700 bg-ink-900 px-3 py-2">
        <h1 className="whitespace-nowrap text-base font-bold">Nature Shield <span className="font-normal text-ink-400">· Operator screen</span></h1>
        <label className="text-xs text-ink-400">
          Scenario{' '}
          <select value={scenarioId ?? ''} onChange={(e) => { setSelectedId(null); setScenarioId(e.target.value); }}
            className="rounded bg-ink-800 px-2 py-1 text-sm text-ink-50">
            {scenarios.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
          </select>
        </label>
        {syntheticLayers.length > 0 && (
          <span className="synthetic-tag" style={{ fontSize: 11, padding: '3px 8px' }}>
            SYNTHETIC {syntheticLayers.join(' and ')}
          </span>
        )}
        {modelStreets && (
          <span className="model-tag" style={{ fontSize: 11, padding: '3px 8px' }}>
            MODEL OUTPUT street access (fire model, not a road survey)
          </span>
        )}
        <span className="ml-auto whitespace-nowrap text-xs text-ink-400">Decision-support prototype · a human confirms every decision</span>
      </header>

      {error && <p className="p-4 text-rose-400">Could not load the scenario: {error}</p>}
      {!data && !error && <p className="p-4 text-ink-400">Loading scenario…</p>}
      {data && (
        <>
          <div className="flex min-h-0 flex-1">
            <aside className="w-[340px] shrink-0 border-r border-ink-700 bg-ink-900">
              <CallerList callers={callers} streets={data.streets.features} now={now} timeZone={timeZone}
                synthetic={data.callersMeta.synthetic === true} selectedId={selected?.id ?? null} onSelect={setSelectedId} />
            </aside>
            <main className="relative min-w-0 flex-1">
              <MapView data={data} now={now} layers={layers} selectedId={selected?.id ?? null}
                nearIds={nearIds} onSelect={setSelectedId} />
            </main>
            <aside className="w-[300px] shrink-0 border-l border-ink-700 bg-ink-900">
              <SidePanel data={data} now={now} timeZone={timeZone} layers={layers}
                onToggle={(k) => setLayers((l) => ({ ...l, [k]: !l[k] }))} />
            </aside>
          </div>
          <TimeBar start={start} end={end} now={now} playing={playing} speed={speed} timeZone={timeZone} marks={marks}
            onSeek={setNow} onPlay={(p) => { if (p && now >= end) setNow(start); setPlaying(p); }} onSpeed={setSpeed} />
        </>
      )}
    </div>
  );
}
