import { STATUS_COLOUR, STATUS_LABEL, STATUS_SHORT, fileKind, fmtAge, fmtTime, statusAt } from '../data';
import type { ScenarioData, StreetStatus } from '../types';
import type { LayerKey } from './MapView';

const LAYER_LABEL: Record<LayerKey, string> = {
  forecast: 'Fire front: forecast',
  observed: 'Fire front: observed',
  streets: 'Street access',
  callers: 'Caller reports',
  crews: 'Response points and routes',
};

interface Props {
  data: ScenarioData;
  now: number;
  timeZone: string;
  layers: Record<LayerKey, boolean>;
  onToggle: (key: LayerKey) => void;
}

type Kind = 'synthetic' | 'model' | 'real';

function KindTag({ kind, long }: { kind: Kind; long?: boolean }) {
  if (kind === 'synthetic') return <span className="synthetic-tag">{long ? 'SYNTHETIC DATA' : 'SYNTHETIC'}</span>;
  if (kind === 'model') return <span className="model-tag">MODEL OUTPUT</span>;
  return long ? null : <span className="rounded bg-emerald-900 px-1.5 text-[10px] font-bold text-emerald-200">REAL DATA</span>;
}

function Section({ title, kind, children }: { title: string; kind?: Kind; children: React.ReactNode }) {
  return (
    <section className="border-b border-ink-700 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-bold uppercase tracking-wider text-ink-400">{title}</h2>
        {kind && <KindTag kind={kind} long />}
      </div>
      {children}
    </section>
  );
}

export function SidePanel({ data, now, timeZone, layers, onToggle }: Props) {
  const fire = data.fire.features.map((f) => f.properties);
  const forecasts = fire.filter((p) => p.kind === 'forecast').sort((a, b) => a.t - b.t);
  const seen = fire.filter((p) => p.kind === 'observed' && p.t <= now).sort((a, b) => b.t - a.t);
  const last = seen[0];
  const streets = data.streets.features.map((f) => f.properties);
  const counts = (['open', 'special_access', 'blocked'] as StreetStatus[]).map(
    (s) => [s, streets.filter((p) => statusAt(p, now) === s).length] as const);
  const imagery = [...new Set(streets.map((p) => p.imagery_date).filter(Boolean))].sort();
  const next = streets.filter((p) => (p.t ?? 0) > now && (p.t ?? 0) <= now + 4 * 3600000);
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
        {(Object.keys(LAYER_LABEL) as LayerKey[]).map((k) => (
          <label key={k} className="flex cursor-pointer items-center gap-2 py-0.5">
            <input type="checkbox" checked={layers[k]} onChange={() => onToggle(k)} />
            {LAYER_LABEL[k]}
          </label>
        ))}
      </Section>

      <Section title="Fire front" kind={data.fireMeta.synthetic === true ? 'synthetic' : undefined}>
        <p className="mb-1 text-xs text-ink-400">Forecast (model, P ≥ 50 %)</p>
        {forecasts.map((p) => (
          <div key={p.id} className="flex items-center gap-2 py-0.5">
            <span className="inline-block h-1 w-5 rounded"
              style={{ background: p.horizon_hours === 8 ? '#fde047' : p.horizon_hours === 20 ? '#fb923c' : '#f97316', opacity: p.t <= now ? 1 : 0.4 }} />
            <span>+{p.horizon_hours} h · {p.area_km2?.toFixed(1)} km²</span>
            <span className="ml-auto text-xs text-ink-400">
              {p.t <= now ? `since ${fmtTime(p.t, timeZone)}` : `in ${fmtAge(p.t - now)}`}
            </span>
          </div>
        ))}
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

      <Section title="Street access" kind={streetKind === 'real' ? undefined : streetKind}>
        {counts.map(([s, n]) => (
          <div key={s} className="flex items-center gap-2 py-0.5">
            <span className="inline-block h-1 w-5 rounded" style={{ background: STATUS_COLOUR[s] }} />
            <span>{streetKind === 'model' ? STATUS_SHORT[s] : STATUS_LABEL[s]}</span>
            <span className="ml-auto font-mono">{n}</span>
          </div>
        ))}
        {next.length > 0 && (
          <p className="mt-1 text-xs" style={{ color: '#fca5a5' }}>
            {next.length} more street{next.length > 1 ? 's' : ''} blocked within 4 h (model)
          </p>
        )}
        <p className="mt-1 text-xs text-ink-400">
          {streetKind === 'model'
            ? 'Blocked = the modelled fire has reached the street. Not a road survey. Click a street for details.'
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
        {files.map(([name, kind, note]) => (
          <div key={name} className="py-1">
            <div className="flex items-center gap-2">
              <b>{name}</b>
              <KindTag kind={kind} />
            </div>
            <div className="text-xs text-ink-400">{note}</div>
          </div>
        ))}
      </Section>
    </div>
  );
}
