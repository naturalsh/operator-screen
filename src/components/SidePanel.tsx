import { useMemo } from 'react';
import { HORIZON_COLOURS, INITIAL_FORECAST_COLOUR, STATUS_COLOUR, STATUS_LABEL, STATUS_SHORT, aheadContours, closureAt, currentForecast, inPolygon, fileKind, fireNearby, fmtAge, fmtTime, modelLabel, statusAt } from '../data';
import type { ScenarioData, StreetStatus } from '../types';
import type { LayerKey, MapMode } from './MapView';
import { CREWS_PER_STATION, CREW_STATUS_COLOUR, CREW_STATUS_LABEL, type CrewState } from '../crews';

const LAYER_LABEL: Record<LayerKey, string> = {
  forecast: 'Fire front: latest forecast',
  initial: 'Fire front: initial forecast (at ignition)',
  observed: 'Fire front: observed',
  streets: 'Street access',
  nearby: 'Fire nearby (satellite), within 1 km of the selected caller and routes',
  callers: 'Caller reports',
  crews: 'Response points and routes',
};

interface Props {
  data: ScenarioData;
  now: number;
  timeZone: string;
  layers: Record<LayerKey, boolean>;
  mode: MapMode;
  onToggle: (key: LayerKey) => void;
  crewStates: CrewState[];
  /** Short label of a report (what a crew is assigned to). */
  labelOf: (reportId: string) => string;
  onSceneMin: number;
  onSceneChange: (minutes: number) => void;
  onFocusCrew: (state: CrewState) => void;
  /** The forecast the operator loaded (forecast library); undefined: the latest update in the file. */
  forecastRunId?: string | null;
}

type Kind = 'synthetic' | 'model' | 'real';

function KindTag({ kind, long, label }: { kind: Kind; long?: boolean; label?: string }) {
  if (kind === 'synthetic') return <span className="synthetic-tag">{long ? 'SYNTHETIC DATA' : 'SYNTHETIC'}</span>;
  if (kind === 'model') return <span className="model-tag">{label ?? 'MODEL OUTPUT'}</span>;
  return long ? null : <span className="rounded bg-emerald-900 px-1.5 text-[10px] font-bold text-emerald-200">REAL DATA</span>;
}

function Section({ title, kind, label, children }: { title: string; kind?: Kind; label?: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-ink-700 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-bold uppercase tracking-wider text-ink-400">{title}</h2>
        {kind && <KindTag kind={kind} long label={label} />}
      </div>
      {children}
    </section>
  );
}

export function SidePanel({ data, now, timeZone, layers, mode, onToggle, crewStates, labelOf, onSceneMin, onSceneChange, onFocusCrew, forecastRunId }: Props) {
  const fire = data.fire.features.map((f) => f.properties);
  const cur = currentForecast(fire, now, forecastRunId);
  const hasUpdates = cur?.set === 'update';
  const forecasts = cur?.contours ?? [];
  const initial = fire.filter((p) => p.kind === 'forecast' && p.set === 'initial').sort((a, b) => a.t - b.t);
  const seen = fire.filter((p) => p.kind === 'observed' && p.t <= now).sort((a, b) => b.t - a.t);
  const last = seen[0];
  const streets = data.streets.features.map((f) => f.properties);
  const counts = (['open', 'special_access', 'blocked'] as StreetStatus[]).map(
    (s) => [s, streets.filter((p) => statusAt(p, now) === s).length] as const);
  const imagery = [...new Set(streets.map((p) => p.imagery_date).filter(Boolean))].sort();
  // What the forecast in force says about streets that are open now (never what will actually happen).
  const ahead = useMemo(() => aheadContours(data.fire.features, now, forecastRunId), [data, now, forecastRunId]);
  const aheadKey = ahead.map((c) => c.properties.id).join('|');
  const nextContour = ahead[0];
  const mayReach = useMemo(() => (nextContour ? data.streets.features.filter((s) => {
    const lp = s.properties.label_point;
    return lp && statusAt(s.properties, now) !== 'blocked' && inPolygon(lp, nextContour.geometry);
  }).length : 0),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [data, aheadKey]);
  const closures = streets.map((p) => closureAt(p, now));
  const by = (k: 'model' | 'satellite' | 'both') => closures.filter((c) => c?.by === k).length;
  const hasSources = streets.some((p) => p.blocked_by);
  const nearby = streets.filter((p) => fireNearby(p, now)).length;
  const streetLabelText = modelLabel(data.streetsMeta);
  const streetKind = fileKind(data.streetsMeta);
  const files = [
    ['FireFront', fileKind(data.fireMeta), 'Fire model + NASA FIRMS, Copernicus Sentinel-2/3'],
    ['StreetAccess', streetKind, data.streetsMeta.note ?? 'Road Check'],
    ['CallerReport', fileKind(data.callersMeta), data.callersMeta.note ?? 'Voice intake'],
    ...(data.responders.length ? [['Responder', fileKind(data.respondersMeta), data.respondersMeta.note ?? ''] as const] : []),
  ] as const;

  return (
    <div className="h-full overflow-y-auto text-sm">
      <Section title="Layers">
        {(Object.keys(LAYER_LABEL) as LayerKey[])
          .filter((k) => (k !== 'initial' || hasUpdates) && (mode === 'detailed' || (k !== 'initial' && k !== 'nearby'))).map((k) => (
          <label key={k} className="flex cursor-pointer items-center gap-2 py-0.5">
            <input type="checkbox" checked={layers[k]} onChange={() => onToggle(k)} />
            {LAYER_LABEL[k]}
          </label>
        ))}
              {mode === 'simple' && (
          <p className="mt-1 text-xs text-ink-400">Detailed mode adds the initial forecast, satellite sensors, model/satellite closures and the fire-nearby warning.</p>
        )}
      </Section>

      {crewStates.length > 0 && (
        <Section title={`Crews · ${crewStates.filter((s) => s.status === 'available').length} of ${crewStates.length} available`}>
          <div data-crews>
            {crewStates.map((s) => {
              const m = s.mission;
              const eta = s.etaMin != null ? `${Math.max(1, Math.ceil(s.etaMin))} min` : '';
              const where = s.status === 'available' ? `at ${s.crew.stationName}`
                : s.status === 'en_route' ? `→ ${labelOf(m!.reportId)} · ETA ${eta}`
                  : s.status === 'holding' ? `→ ${labelOf(m!.reportId)} · stopped, route cut`
                    : s.status === 'on_scene' ? `${labelOf(m!.reportId)} · ${s.cutOff ? 'no road back' : `leaves in ${eta}`}`
                      : `→ ${s.crew.stationName} · back in ${eta}`;
              return (
                <button key={s.crew.id} data-crew={s.crew.id} data-crew-status={s.status} onClick={() => onFocusCrew(s)}
                  className="block w-full rounded px-1 py-1 text-left hover:bg-ink-800" title="Show on the map">
                  <span className="flex items-center gap-2">
                    <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: CREW_STATUS_COLOUR[s.status] }} />
                    <b>{s.crew.name}</b>
                    <span className="ml-auto whitespace-nowrap text-xs" style={{ color: CREW_STATUS_COLOUR[s.status] }}>{CREW_STATUS_LABEL[s.status]}</span>
                  </span>
                  <span className="block pl-[18px] text-xs text-ink-400">{where}</span>
                  <span className="block pl-[18px] font-mono text-[10px] text-ink-400">{s.position[1].toFixed(4)}° N, {s.position[0].toFixed(4)}° E</span>
                </button>
              );
            })}
          </div>
          <label className="mt-2 flex items-center gap-2 text-xs text-ink-200">
            Time on scene
            <input type="number" min={5} max={480} step={5} defaultValue={onSceneMin} aria-label="Minutes on scene" key={onSceneMin}
              onBlur={(e) => onSceneChange(Number(e.target.value))}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              className="w-16 rounded bg-ink-800 px-2 py-1 text-sm text-ink-50" />
            min
          </label>
          <p className="mt-1 text-xs text-ink-400">
            Assumptions: {CREWS_PER_STATION} crews per response point; a crew stays on scene for the time above
            (new dispatches), then drives back. Click a crew to find it on the map.
          </p>
        </Section>
      )}

      <Section title="Fire front" kind={data.fireMeta.synthetic === true ? 'synthetic' : undefined}>
        {cur ? (
          <p className="mb-1 text-xs" data-forecast-issued>
            <b>Forecast issued {fmtTime(cur.issuedAt, timeZone)}</b> from {cur.from}
            <span className="text-ink-400"> · model, P ≥ 50 %{forecastRunId !== undefined ? ' · precomputed, loaded by the operator' : hasUpdates ? ` · update ${cur.index} of ${cur.count}` : ''}</span>
          </p>
        ) : <p className="mb-1 text-xs text-ink-400">No forecast issued yet.</p>}
        {forecasts.map((p) => (
          <div key={p.id} className="flex items-center gap-2 py-0.5">
            <span className="inline-block h-1 w-5 rounded"
              style={{ background: HORIZON_COLOURS[p.rank ?? 0], opacity: p.t <= now ? 1 : 0.4 }} />
            <span>+{p.horizon_hours} h · {p.area_km2?.toFixed(1)} km²</span>
            <span className="ml-auto text-xs text-ink-400">
              {p.t <= now ? `since ${fmtTime(p.t, timeZone)}` : `in ${fmtAge(p.t - now)}`}
            </span>
          </div>
        ))}
        {hasUpdates && layers.initial && mode === 'detailed' && (
          <div className="mt-1" data-initial-forecast>
            <p className="mb-1 text-xs text-ink-400">Initial forecast, issued at ignition ({fmtTime(initial[0]?.issue_t ?? 0, timeZone)})</p>
            {initial.map((p) => (
              <div key={p.id} className="flex items-center gap-2 py-0.5">
                <span className="inline-block h-0.5 w-5" style={{ background: INITIAL_FORECAST_COLOUR, opacity: p.t <= now ? 1 : 0.4 }} />
                <span>+{p.horizon_hours} h · {p.area_km2?.toFixed(1)} km²</span>
                <span className="ml-auto text-xs text-ink-400">
                  {p.t <= now ? `since ${fmtTime(p.t, timeZone)}` : `in ${fmtAge(p.t - now)}`}
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="mb-1 mt-2 text-xs text-ink-400">Observed (satellite)</p>
        {last ? (
          <div>
            <div>Last pass: <b>{last.instrument} {last.satellite}</b>, {fmtAge(now - last.t)} ago</div>
            <div className="text-xs text-ink-400">
              {fmtTime(last.t, timeZone)} · {last.observation_type?.replace('_', ' ')}
              {last.detections ? ` · ${last.detections} hotspots` : ''} · {seen.length} passes so far
            </div>
          </div>
        ) : <div className="text-ink-400">No satellite pass yet.</div>}
        <div className="mt-2 grid grid-cols-2 gap-x-2 text-xs text-ink-200">
          <span><span style={{ color: '#ef4444' }}>■</span> VIIRS 375 m</span>
          <span><span style={{ color: '#a855f7' }}>■</span> MODIS 1 km</span>
          <span><span style={{ color: '#14b8a6' }}>■</span> SLSTR 1 km</span>
          <span><span style={{ color: '#fde047' }}>■</span> Flame front (S-2)</span>
          <span>▬ Burned area (S-2)</span>
          <span>★ Ignition</span>
        </div>
      </Section>

      <Section title="Street access" kind={streetKind === 'real' ? undefined : streetKind} label={streetLabelText}>
        {counts.map(([s, n]) => (
          <div key={s} className="flex items-center gap-2 py-0.5">
            <span className="inline-block h-1 w-5 rounded" style={{ background: STATUS_COLOUR[s] }} />
            <span>{streetKind === 'model' ? STATUS_SHORT[s] : STATUS_LABEL[s]}</span>
            <span className="ml-auto font-mono">{n}</span>
          </div>
        ))}
        {hasSources && (
          <div className="ml-7 text-xs text-ink-200" data-blocked-split>
            <div className="flex items-center gap-2 py-0.5">
              <span className="inline-block h-0.5 w-5" style={{ background: STATUS_COLOUR.blocked }} />
              seen by satellite<span className="ml-auto font-mono">{by('satellite') + by('both')}</span>
            </div>
            <div className="flex items-center gap-2 py-0.5">
              <span className="inline-block w-5 border-t-2 border-dashed" style={{ borderColor: '#fb923c' }} />
              forecast only<span className="ml-auto font-mono">{by('model')}</span>
            </div>
          </div>
        )}
        {hasSources && mode === 'detailed' && (
          <div className="flex items-center gap-2 py-0.5" data-nearby>
            <span className="inline-block h-1.5 w-5 rounded" style={{ background: '#fbbf24', opacity: 0.6 }} />
            <span>Fire nearby (satellite), open</span>
            <span className="ml-auto font-mono">{nearby}</span>
          </div>
        )}
        {nextContour && mayReach > 0 && (
          <p className="mt-1 text-xs" style={{ color: '#fdba74' }} data-forecast-reach>
            Forecast (issued {fmtTime(nextContour.properties.issue_t ?? 0, timeZone)}): fire may reach {mayReach} more
            street{mayReach > 1 ? 's' : ''} by {fmtTime(nextContour.properties.t, timeZone)} (+{nextContour.properties.horizon_hours} h)
          </p>
        )}
        <p className="mt-1 text-xs text-ink-400">
          {streetKind === 'model'
            ? (hasSources
              ? 'Solid red: a satellite has seen fire on the street (VIIRS 375 m pixel, Sentinel-2 flame front or burned area, '
                + 'or MODIS/SLSTR pixels in two passes 30 min to 6 h apart with a VIIRS/Sentinel-2 detection within 1 km). '
                + 'Orange dashed: forecast closure, the forecast in force reaches the street but no satellite has seen fire there '
                + 'yet. Crews are routed around both. Not a road survey. Click a street for details.'
              : 'Blocked = the forecast in force has reached the street. Not a road survey. Click a street for details.')
            : `Imagery date: ${imagery.join(', ') || 'n/a'}. Click a street for its width.`}
        </p>
      </Section>

      {data.responders.length > 0 && (
        <Section title="Response points">
          {data.responders.map((r) => (
            <div key={r.id} className="py-0.5">
              <span style={{ color: '#22d3ee' }}>●</span> {r.name}
              <span className="text-xs text-ink-400"> · {r.kind.replace('_', ' ')}</span>
            </div>
          ))}
          <p className="mt-1 text-xs text-ink-400">
            Real locations from OpenStreetMap. Crew availability is assumed. Routes avoid streets blocked at the
            current time; times are free-flow drive times.
          </p>
        </Section>
      )}

      <Section title="Data on this screen">
        <p className="mb-1 text-xs text-ink-400">
          Basemap: OpenFreeMap, © OpenMapTiles, data © OpenStreetMap contributors.
        </p>
        {files.map(([name, kind, note]) => (
          <div key={name} className="py-1">
            <div className="flex items-center gap-2">
              <b>{name}</b>
              <KindTag kind={kind} label={name === 'StreetAccess' ? streetLabelText : undefined} />
            </div>
            <div className="text-xs text-ink-400">{note}</div>
          </div>
        ))}
      </Section>
    </div>
  );
}
