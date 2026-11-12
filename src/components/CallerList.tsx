import { STATUS_COLOUR, STATUS_SHORT, URGENCY_COLOUR, URGENCY_LABEL, fmtAge, fmtTime, statusAt, streetsNear } from '../data';
import type { CallerReport, StreetFeature } from '../types';

export const NEAR_RADIUS_M = 600;

interface Props {
  callers: CallerReport[];
  streets: StreetFeature[];
  now: number;
  timeZone: string;
  synthetic: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export function CallerList({ callers, streets, now, timeZone, synthetic, selectedId, onSelect }: Props) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-ink-700 px-3 py-2">
        <h2 className="text-xs font-bold uppercase tracking-wider text-ink-400">Caller reports · {callers.length}</h2>
        {synthetic && <span className="synthetic-tag">SYNTHETIC DATA</span>}
      </div>
      <div className="flex-1 overflow-y-auto">
        {callers.length === 0 && <p className="p-3 text-ink-400">No reports yet at this time.</p>}
        {callers.map((c) => {
          const selected = c.id === selectedId;
          const near = selected ? streetsNear(streets, c, NEAR_RADIUS_M) : [];
          const count = (s: string) => near.filter((n) => statusAt(n.street.properties, now) === s).length;
          return (
            <button key={c.id} onClick={() => onSelect(selected ? null : c.id)}
              className={`block w-full border-b border-ink-800 px-3 py-2 text-left hover:bg-ink-850 ${selected ? 'bg-ink-800' : ''}`}
              style={{ borderLeft: `4px solid ${URGENCY_COLOUR[c.urgency]}` }}>
              <div className="flex items-center gap-2">
                <span className="rounded px-1.5 py-0.5 text-[10px] font-bold text-ink-950" style={{ background: URGENCY_COLOUR[c.urgency] }}>
                  {URGENCY_LABEL[c.urgency]}
                </span>
                {c.people_at_risk > 0 && <span className="text-xs font-semibold">{c.people_at_risk} at risk</span>}
                <span className="ml-auto font-mono text-[11px] text-ink-400">{fmtAge(now - Date.parse(c.reported_at))} ago</span>
              </div>
              <div className="mt-1 font-semibold">{c.place.label ?? `${c.place.lat.toFixed(4)}, ${c.place.lon.toFixed(4)}`}</div>
              <div className="text-ink-200">{c.summary_en ?? c.summary}</div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-ink-400">
                <span>{fmtTime(Date.parse(c.reported_at), timeZone)}</span>
                <span>{c.language.toUpperCase()}{c.channel ? ` · ${c.channel}` : ''}</span>
                <span>{c.confirmed_by_operator ? '✓ confirmed by operator' : 'suggested urgency, not confirmed'}</span>
                {c.synthetic && <span className="synthetic-tag">SYNTHETIC</span>}
              </div>
              {selected && (
                <div className="mt-2 rounded border border-ink-600 bg-ink-900 p-2 text-xs">
                  {c.summary_en && <p className="mb-1 italic text-ink-200">“{c.summary}”</p>}
                  <p className="mb-1 text-ink-400">Why: {c.urgency_reasons.join(', ')}</p>
                  <p className="font-semibold">Streets within {NEAR_RADIUS_M} m: {near.length}</p>
                  <p>
                    <span style={{ color: STATUS_COLOUR.open }}>■</span> {count('open')} open ·{' '}
                    <span style={{ color: STATUS_COLOUR.special_access }}>■</span> {count('special_access')} special access ·{' '}
                    <span style={{ color: STATUS_COLOUR.blocked }}>■</span> {count('blocked')} blocked
                  </p>
                  <ul className="mt-1 space-y-0.5">
                    {near.slice(0, 6).map(({ street, dist }) => {
                      const p = street.properties;
                      const st = statusAt(p, now);
                      const soon = (p.t ?? 0) > now ? ` → ${STATUS_SHORT[p.status].toLowerCase()} ${fmtTime(p.t!, timeZone)}` : '';
                      return (
                        <li key={p.id} className="flex gap-1.5">
                          <span style={{ color: STATUS_COLOUR[st] }}>■</span>
                          <span className="truncate">{p.name || `${p.highway ?? 'way'} ${p.osm_way_id}`}</span>
                          <span className="ml-auto whitespace-nowrap font-mono text-ink-400">
                            {p.free_width_m != null ? `${p.free_width_m} m wide · ` : ''}{Math.round(dist)} m{soon}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
