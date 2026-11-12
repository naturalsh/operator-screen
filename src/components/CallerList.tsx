import { useState } from 'react';
import {
  STAGE_COLOUR, STAGE_LABEL, STATUS_COLOUR, STATUS_SHORT, URGENCY_COLOUR, URGENCY_LABEL,
  fmtAge, fmtTime, statusAt, streetLabel, streetsNear,
} from '../data';
import type { RoutePlan } from '../routing';
import type { CallerReport, Stage, StreetFeature, Urgency } from '../types';

export const NEAR_RADIUS_M = 600;

export interface CaseState {
  stage: Stage;
  /** Urgency confirmed (or changed) by the operator; the agent's suggestion stays in the report. */
  urgency?: Urgency;
  route?: RoutePlan;
  /** Scenario time of the last dispatch / re-route attempt that found no road access. */
  noAccessAt?: number;
}

export interface RouteCheck { cut: StreetFeature[]; alternative: RoutePlan | null }

interface Props {
  callers: CallerReport[];
  streets: StreetFeature[];
  now: number;
  timeZone: string;
  synthetic: boolean;
  selectedId: string | null;
  cases: Record<string, CaseState>;
  routeChecks: Record<string, RouteCheck>;
  canRoute: boolean;
  onSelect: (id: string | null) => void;
  onTake: (c: CallerReport) => void;
  onConfirm: (c: CallerReport, urgency: Urgency) => void;
  onDispatch: (c: CallerReport) => void;
  onReroute: (c: CallerReport) => void;
}

const btn = 'rounded px-2.5 py-1 text-xs font-bold text-ink-950 hover:brightness-110';

function fmtRoute(r: RoutePlan): string {
  return `${Math.max(1, Math.round(r.minutes))} min · ${r.km.toFixed(1)} km`;
}

function Actions({ c, cs, check, now, timeZone, canRoute, onTake, onConfirm, onDispatch, onReroute }: {
  c: CallerReport; cs: CaseState; check?: RouteCheck; now: number; timeZone: string; canRoute: boolean;
} & Pick<Props, 'onTake' | 'onConfirm' | 'onDispatch' | 'onReroute'>) {
  const [choice, setChoice] = useState<Urgency>(cs.urgency ?? c.urgency);
  const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn(); };
  const noAccess = cs.noAccessAt != null && (
    <p className="mt-1 rounded border border-rose-500 bg-rose-950/60 px-2 py-1 text-xs font-semibold text-rose-200">
      ⚠ No access by road at this time ({fmtTime(cs.noAccessAt, timeZone)}). Every route is cut by blocked streets.
    </p>
  );
  return (
    <div className="mt-2" onClick={(e) => e.stopPropagation()}>
      {cs.stage === 'new' && (
        <button className={`${btn} bg-slate-200`} onClick={stop(() => onTake(c))}>Take</button>
      )}
      {cs.stage === 'taken' && (
        <div className="flex items-center gap-2">
          <select aria-label="Urgency" value={choice} onChange={(e) => setChoice(e.target.value as Urgency)}
            className="rounded bg-ink-700 px-1 py-1 text-xs text-ink-50">
            {(Object.keys(URGENCY_LABEL) as Urgency[]).map((u) => <option key={u} value={u}>{URGENCY_LABEL[u]}</option>)}
          </select>
          <button className={`${btn} bg-emerald-300`} onClick={stop(() => onConfirm(c, choice))}>Confirm urgency</button>
          {choice !== c.urgency && <span className="text-[11px] text-ink-400">agent suggested {URGENCY_LABEL[c.urgency]}</span>}
        </div>
      )}
      {cs.stage === 'confirmed' && (
        <>
          <button className={`${btn} bg-cyan-300 disabled:opacity-40`} disabled={!canRoute}
            onClick={stop(() => onDispatch(c))}>{cs.noAccessAt != null ? 'Try dispatch again' : 'Dispatch'}</button>
          {!canRoute && <span className="ml-2 text-[11px] text-ink-400">no response points in this scenario</span>}
          {noAccess}
        </>
      )}
      {cs.stage === 'dispatched' && cs.route && (
        <div className="rounded border border-cyan-700 bg-cyan-950/40 p-2 text-xs">
          <div><b>{cs.route.responderName}</b> → caller · <b>{fmtRoute(cs.route)}</b></div>
          <div className="text-ink-400">
            drive time at free-flow speeds, blocked streets avoided · computed for {fmtTime(cs.route.computedAt, timeZone)}
          </div>
          {cs.route.lastStretchBlocked && (
            <div className="mt-1 text-amber-200">
              ⚠ The caller's street is blocked: the crew stops {Math.round(cs.route.lastStretchM)} m away.
            </div>
          )}
          {check && check.cut.length > 0 && (
            <div className="mt-1 rounded border border-amber-500 bg-amber-950/60 p-1.5 text-amber-100">
              ⚠ Route cut at {fmtTime(now, timeZone)}: {streetLabel(check.cut[0].properties)}
              {check.cut.length > 1 ? ` and ${check.cut.length - 1} more` : ''} now blocked.
              {check.alternative ? (
                <div className="mt-1">
                  <div>New route: <b>{check.alternative.responderName}</b>, {fmtRoute(check.alternative)}</div>
                  <button className={`${btn} mt-1 bg-amber-300`} onClick={stop(() => onReroute(c))}>Use new route</button>
                </div>
              ) : (
                <div className="mt-1 font-semibold text-rose-200">No access by road at this time.</div>
              )}
            </div>
          )}
          {noAccess}
        </div>
      )}
    </div>
  );
}

export function CallerList(props: Props) {
  const { callers, streets, now, timeZone, synthetic, selectedId, cases, routeChecks, onSelect } = props;
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
          const cs = cases[c.id] ?? { stage: 'new' as const };
          const urgency = cs.urgency ?? c.urgency;
          const near = selected ? streetsNear(streets, c, NEAR_RADIUS_M) : [];
          const count = (s: string) => near.filter((n) => statusAt(n.street.properties, now) === s).length;
          return (
            <div key={c.id} role="button" tabIndex={0} data-report={c.id}
              onClick={() => onSelect(selected ? null : c.id)}
              onKeyDown={(e) => { if (e.key === 'Enter') onSelect(selected ? null : c.id); }}
              className={`cursor-pointer border-b border-ink-800 px-3 py-2 text-left hover:bg-ink-850 ${selected ? 'bg-ink-800' : ''}`}
              style={{ borderLeft: `4px solid ${URGENCY_COLOUR[urgency]}` }}>
              <div className="flex items-center gap-2">
                <span className="whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-bold text-ink-950" style={{ background: URGENCY_COLOUR[urgency] }}>
                  {URGENCY_LABEL[urgency]}
                </span>
                <span className="whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-bold"
                  style={{ color: STAGE_COLOUR[cs.stage], borderColor: STAGE_COLOUR[cs.stage] }}>{STAGE_LABEL[cs.stage]}</span>
                {c.people_at_risk > 0 && <span className="whitespace-nowrap text-xs font-semibold">{c.people_at_risk} at risk</span>}
                <span className="ml-auto whitespace-nowrap font-mono text-[11px] text-ink-400">{fmtAge(now - Date.parse(c.reported_at))}</span>
              </div>
              <div className="mt-1 font-semibold">{c.place.label ?? `${c.place.lat.toFixed(4)}, ${c.place.lon.toFixed(4)}`}</div>
              <div className="text-ink-200">{c.summary_en ?? c.summary}</div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-ink-400">
                <span>{fmtTime(Date.parse(c.reported_at), timeZone)}</span>
                <span>{c.language.toUpperCase()}{c.channel ? ` · ${c.channel}` : ''}</span>
                <span>{cs.urgency ? (cs.urgency === c.urgency ? 'urgency confirmed' : `urgency changed from ${URGENCY_LABEL[c.urgency]}`)
                  : 'urgency suggested by the agent'}</span>
                {c.synthetic && <span className="synthetic-tag">SYNTHETIC</span>}
              </div>
              <Actions c={c} cs={cs} check={routeChecks[c.id]} now={now} timeZone={timeZone} canRoute={props.canRoute}
                onTake={props.onTake} onConfirm={props.onConfirm} onDispatch={props.onDispatch} onReroute={props.onReroute} />
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
                  <ul className="mt-1 space-y-1">
                    {near.slice(0, 6).map(({ street, dist }) => {
                      const p = street.properties;
                      const st = statusAt(p, now);
                      const soon = (p.t ?? 0) > now ? ` → ${STATUS_SHORT[p.status].toLowerCase()} ${fmtTime(p.t!, timeZone)}` : '';
                      return (
                        <li key={p.id} className="flex gap-1.5">
                          <span style={{ color: STATUS_COLOUR[st] }}>■</span>
                          <span>
                            {streetLabel(p)}
                            <span className="block font-mono text-ink-400">
                              {p.free_width_m != null ? `${p.free_width_m} m wide · ` : ''}{Math.round(dist)} m away{soon}
                            </span>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
