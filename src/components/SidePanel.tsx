import { STATUS_COLOUR, STATUS_LABEL, fmtAge, fmtTime } from '../data';
import type { ScenarioData, StreetStatus } from '../types';
import type { LayerKey } from './MapView';

const LAYER_LABEL: Record<LayerKey, string> = {
  forecast: 'Fire front: forecast',
  observed: 'Fire front: observed',
  streets: 'Street access',
  callers: 'Caller reports',
};

interface Props {
  data: ScenarioData;
  now: number;
  timeZone: string;
  layers: Record<LayerKey, boolean>;
  onToggle: (key: LayerKey) => void;
}

function Section({ title, tag, children }: { title: string; tag?: boolean; children: React.ReactNode }) {
  return (
    <section className="border-b border-ink-700 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-bold uppercase tracking-wider text-ink-400">{title}</h2>
        {tag && <span className="synthetic-tag">SYNTHETIC DATA</span>}
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
    (s) => [s, streets.filter((p) => p.status === s).length] as const);
  const imagery = [...new Set(streets.map((p) => p.imagery_date))].sort();
  const files = [
    ['FireFront', data.fireMeta.synthetic === true, 'Fire model + NASA FIRMS, Copernicus Sentinel-2/3'],
    ['StreetAccess', data.streetsMeta.synthetic === true, data.streetsMeta.note ?? 'Road Check'],
    ['CallerReport', data.callersMeta.synthetic === true, data.callersMeta.note ?? 'Voice intake'],
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

      <Section title="Fire front" tag={data.fireMeta.synthetic === true}>
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

      <Section title="Street access" tag={data.streetsMeta.synthetic === true}>
        {counts.map(([s, n]) => (
          <div key={s} className="flex items-center gap-2 py-0.5">
            <span className="inline-block h-1 w-5 rounded" style={{ background: STATUS_COLOUR[s] }} />
            <span>{STATUS_LABEL[s]}</span>
            <span className="ml-auto font-mono">{n}</span>
          </div>
        ))}
        <p className="mt-1 text-xs text-ink-400">Imagery date: {imagery.join(', ')}. Click a street for its width.</p>
      </Section>

      <Section title="Data on this screen">
        {files.map(([name, synthetic, note]) => (
          <div key={name} className="py-1">
            <div className="flex items-center gap-2">
              <b>{name}</b>
              {synthetic ? <span className="synthetic-tag">SYNTHETIC</span>
                : <span className="rounded bg-emerald-900 px-1.5 text-[10px] font-bold text-emerald-200">REAL DATA</span>}
            </div>
            <div className="text-xs text-ink-400">{note}</div>
          </div>
        ))}
      </Section>
    </div>
  );
}
