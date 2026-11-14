import { useState } from 'react';
import {
  STAGE_COLOUR, STAGE_LABEL, STATUS_COLOUR, URGENCY_COLOUR, URGENCY_LABEL,
  aheadContours, closureAt, closureSource, fireNearby, fmtAge, fmtTime, forecastReach, statusAt, streetLabel, streetsNear,
} from '../data';
import { CREW_STATUS_COLOUR, CREW_STATUS_LABEL, type Candidate, type CrewStatus } from '../crews';
import type { CallerReport, Stage, StreetFeature, Urgency } from '../types';

export const NEAR_RADIUS_M = 600;

export interface CaseState {
  stage: Stage;
  /** Urgency confirmed (or changed) by the operator; the agent's suggestion stays in the report. */
  urgency?: Urgency;
  /** The crew mission serving this report. */
  missionId?: number;
  /** Scenario time of the last dispatch / re-route attempt that found no road access. */
  noAccessAt?: number;
  /** Scenario time of the last dispatch attempt that found no crew free, and why. */
  noCrewAt?: number;
  noCrewNote?: string;
  /** Why the report has no crew any more (its crew was redirected). */
  unassignedNote?: string;
}

/** What a dispatched report's card shows about its crew at the current time. */
export interface CardCrew {
  crewName: string;
  status: CrewStatus;
  /** Minutes to arrival (en route), to leaving (on scene) or to the station (returning). */
  etaMin: number | null;
  km: number;
  trackKm: number;
  sentAt: number;
  arrivedAt: number | null;
  leftAt: number | null;
  lastStretchBlocked: boolean;
  lastStretchM: number;
  cutOff: boolean;
  /** Holding: when and where the route was cut, and the new route from where the vehicle is (null = none). */
  holdFrom: number | null;
  cutStreet: string | null;
  alternative: { minutes: number; km: number } | null;
  /** Station or caller far from a mapped road. */
  snapWarnings: string[];
}

interface Props {
  callers: CallerReport[];
  streets: StreetFeature[];
  now: number;
  timeZone: string;
  synthetic: boolean;
  selectedId: string | null;
  cases: Record<string, CaseState>;
  cardCrews: Record<string, CardCrew>;
  /** Crews that could be sent to the selected report, fastest first (null = not computed). */
  candidates: Candidate[] | null;
  /** Reports waiting for a crew, as targets for redirecting one that is en route. */
  awaiting: { id: string; label: string }[];
  labelOf: (reportId: string) => string;
  /** Contours of the forecast in force that lie ahead: the only source for "fire may reach" notes. */
  ahead: ReturnType<typeof aheadContours>;
  canRoute: boolean;
  onSelect: (id: string | null) => void;
  onTake: (c: CallerReport) => void;
  onConfirm: (c: CallerReport, urgency: Urgency) => void;
  onDispatch: (c: CallerReport, crewId?: string) => void;
  onReroute: (c: CallerReport) => void;
  onReassign: (from: CallerReport, toReportId: string) => void;
}

const btn = 'rounded px-2.5 py-1 text-xs font-bold text-ink-950 hover:brightness-110';
const mins = (m: number) => `${Math.max(1, Math.ceil(m))} min`;

function candidateLabel(k: Candidate, labelOf: Props['labelOf']): string {
  const where = k.state.status === 'available' ? 'at station'
    : k.state.status === 'returning' ? 'returning'
      : `en route to ${labelOf(k.state.mission!.reportId).split(' (')[0]}`;
  return `${k.crew.name} · ETA ${mins(k.minutes)} · ${k.leg.km.toFixed(1)} km · ${where}`;
}

function DispatchControls({ c, cs, selected, candidates, canRoute, labelOf, onDispatch, timeZone }: {
  c: CallerReport; cs: CaseState; selected: boolean;
} & Pick<Props, 'candidates' | 'canRoute' | 'labelOf' | 'onDispatch' | 'timeZone'>) {
  const [choice, setChoice] = useState<string>('');
  const list = selected ? candidates : null;
  const suggested = list?.find((k) => !k.needsApproval) ?? null;
  const picked = list?.find((k) => k.crew.id === choice) ?? suggested;
  const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn(); };
  return (
    <>
      {cs.stage === 'unassigned' && (
        <p className="mb-1 rounded border border-rose-500 bg-rose-950/60 px-2 py-1 text-xs font-semibold text-rose-200" data-unassigned>
          ⚠ Unassigned: {cs.unassignedNote ?? 'the crew was redirected'}. This incident has no crew.
        </p>
      )}
      {list && list.length > 0 && (
        <div className="mb-1 rounded border border-ink-600 bg-ink-900 p-2 text-xs" data-candidates>
          <div>
            {suggested
              ? <>Suggested: <b>{suggested.crew.name}</b> · <b>ETA {mins(suggested.minutes)}</b> · {suggested.leg.km.toFixed(1)} km</>
              : <span className="text-amber-200">No crew is free. A crew en route elsewhere can be redirected:</span>}
          </div>
          <select aria-label="Crew" value={picked?.crew.id ?? ''} onChange={(e) => setChoice(e.target.value)}
            onClick={(e) => e.stopPropagation()} className="mt-1 w-full rounded bg-ink-700 px-1 py-1 text-xs text-ink-50">
            {list.map((k) => (
              <option key={k.crew.id} value={k.crew.id}>
                {k.needsApproval ? '⚠ ' : ''}{candidateLabel(k, labelOf)}{k === suggested ? ' (suggested)' : ''}
              </option>
            ))}
          </select>
          {picked?.needsApproval && (
            <div className="mt-1 text-amber-200">
              {picked.crew.name} is on its way to another incident. Sending it here leaves that incident without a crew.
            </div>
          )}
        </div>
      )}
      <button className={`${btn} ${picked?.needsApproval ? 'bg-amber-300' : 'bg-cyan-300'} disabled:opacity-40`} disabled={!canRoute}
        onClick={stop(() => onDispatch(c, picked?.crew.id))}>
        {picked ? (picked.needsApproval ? `Reassign ${picked.crew.name} here` : `Dispatch ${picked.crew.name}`)
          : cs.noAccessAt != null || cs.noCrewAt != null ? 'Try dispatch again' : 'Dispatch'}
      </button>
      {!canRoute && <span className="ml-2 text-[11px] text-ink-400">no response points in this scenario</span>}
      {!selected && <span className="ml-2 text-[11px] text-ink-400">nearest free crew · select the card to choose</span>}
      {cs.noAccessAt != null && (
        <p className="mt-1 rounded border border-rose-500 bg-rose-950/60 px-2 py-1 text-xs font-semibold text-rose-200">
          ⚠ No access by road at this time ({fmtTime(cs.noAccessAt, timeZone)}). Every route is cut by blocked streets.
        </p>
      )}
      {cs.noCrewAt != null && (
        <p className="mt-1 rounded border border-amber-500 bg-amber-950/60 px-2 py-1 text-xs font-semibold text-amber-100" data-no-crew>
          ⚠ No crew free at {fmtTime(cs.noCrewAt, timeZone)}{cs.noCrewNote ? `: ${cs.noCrewNote}` : ''}.
        </p>
      )}
    </>
  );
}

function CrewBox({ c, cs, crew, now, timeZone, awaiting, onReroute, onReassign }: {
  c: CallerReport; cs: CaseState; crew: CardCrew; now: number;
} & Pick<Props, 'timeZone' | 'awaiting' | 'onReroute' | 'onReassign'>) {
  const targets = awaiting.filter((a) => a.id !== c.id);
  const [to, setTo] = useState('');
  const target = targets.find((a) => a.id === to) ?? targets[0];
  const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn(); };
  const moving = crew.status === 'en_route' || crew.status === 'holding';
  return (
    <div className="rounded border border-cyan-700 bg-cyan-950/40 p-2 text-xs" data-crew-box={crew.status}>
      <div className="flex items-center gap-2">
        <span className="rounded px-1.5 py-0.5 text-[10px] font-bold text-ink-950" style={{ background: CREW_STATUS_COLOUR[crew.status] }}>
          {CREW_STATUS_LABEL[crew.status].toUpperCase()}
        </span>
        <span>
          <b>{crew.crewName}</b> → caller
          {crew.status === 'en_route' && crew.etaMin != null && <> · <b data-eta>ETA {mins(crew.etaMin)}</b></>}
          {' '}· {crew.km.toFixed(1)} km{crew.trackKm >= 0.5 ? ` (${crew.trackKm.toFixed(1)} km on forest tracks)` : ''}
        </span>
      </div>
      <div className="mt-0.5 text-ink-400">
        {crew.status === 'en_route' && <>sent {fmtTime(crew.sentAt, timeZone)} · free-flow drive time, blocked streets avoided</>}
        {crew.status === 'on_scene' && (crew.cutOff
          ? <>on scene since {fmtTime(crew.arrivedAt!, timeZone)} · <span className="text-amber-200">no road back to the station at this time</span></>
          : <>on scene since {fmtTime(crew.arrivedAt!, timeZone)} · leaves in {mins(crew.etaMin ?? 0)}</>)}
        {crew.status === 'returning' && <>left the scene {fmtTime(crew.leftAt!, timeZone)} · back at the station in {mins(crew.etaMin ?? 0)}</>}
        {crew.status === 'available' && <>arrived {crew.arrivedAt ? fmtTime(crew.arrivedAt, timeZone) : '—'}, left {crew.leftAt ? fmtTime(crew.leftAt, timeZone) : '—'} · crew is back at its station</>}
      </div>
      {crew.snapWarnings.map((w) => (
        <div key={w} className="mt-1 text-amber-200" data-snap-warning>⚠ {w}.</div>
      ))}
      {crew.lastStretchBlocked && crew.status !== 'holding' && (
        <div className="mt-1 text-amber-200">
          ⚠ The caller's street is blocked: the crew stops {Math.round(crew.lastStretchM)} m away.
        </div>
      )}
      {crew.status === 'holding' && (
        <div className="mt-1 rounded border border-amber-500 bg-amber-950/60 p-1.5 text-amber-100">
          ⚠ Route cut at {fmtTime(crew.holdFrom ?? now, timeZone)}{crew.cutStreet ? `: ${crew.cutStreet} now blocked` : ''}.
          The vehicle is holding where it was.
          {crew.alternative ? (
            <div className="mt-1">
              <div>New route from the vehicle's position: <b>{mins(crew.alternative.minutes)} · {crew.alternative.km.toFixed(1)} km</b></div>
              <button className={`${btn} mt-1 bg-amber-300`} onClick={stop(() => onReroute(c))}>Use new route</button>
            </div>
          ) : (
            <div className="mt-1 font-semibold text-rose-200">No access by road at this time.</div>
          )}
        </div>
      )}
      {moving && targets.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 border-t border-cyan-900 pt-1.5" onClick={(e) => e.stopPropagation()}>
          <span className="text-ink-400">Redirect to</span>
          <select aria-label="Redirect crew to" value={target?.id ?? ''} onChange={(e) => setTo(e.target.value)}
            className="min-w-0 flex-1 rounded bg-ink-700 px-1 py-1 text-xs text-ink-50">
            {targets.map((a) => <option key={a.id} value={a.id}>{a.label.split(' (')[0]}</option>)}
          </select>
          <button className={`${btn} bg-amber-300`} data-reassign onClick={stop(() => target && onReassign(c, target.id))}>Reassign</button>
        </div>
      )}
      {cs.noAccessAt != null && (
        <p className="mt-1 rounded border border-rose-500 bg-rose-950/60 px-2 py-1 font-semibold text-rose-200">
          ⚠ No access by road at this time ({fmtTime(cs.noAccessAt, timeZone)}).
        </p>
      )}
    </div>
  );
}

function Actions(props: { c: CallerReport; cs: CaseState; selected: boolean } & Props) {
  const { c, cs, onTake, onConfirm } = props;
  const [choice, setChoice] = useState<Urgency>(cs.urgency ?? c.urgency);
  const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn(); };
  const crew = props.cardCrews[c.id];
  return (
    <div className="mt-2" onClick={(e) => e.stopPropagation()}>
      {cs.stage === 'new' && (
        <button className={`${btn} bg-slate-200`} onClick={stop(() => onTake(c))}>Take</button>
      )}
      {cs.stage === 'taken' && (
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Urgency" value={choice} onChange={(e) => setChoice(e.target.value as Urgency)}
            className="rounded bg-ink-700 px-1 py-1 text-xs text-ink-50">
            {(Object.keys(URGENCY_LABEL) as Urgency[]).map((u) => <option key={u} value={u}>{URGENCY_LABEL[u]}</option>)}
          </select>
          <button className={`${btn} bg-emerald-300`} onClick={stop(() => onConfirm(c, choice))}>Confirm urgency</button>
          {choice !== c.urgency && <span className="text-[11px] text-ink-400">agent suggested {URGENCY_LABEL[c.urgency]}</span>}
        </div>
      )}
      {(cs.stage === 'confirmed' || cs.stage === 'unassigned') && (
        <DispatchControls c={c} cs={cs} selected={props.selected} candidates={props.candidates} canRoute={props.canRoute}
          labelOf={props.labelOf} onDispatch={props.onDispatch} timeZone={props.timeZone} />
      )}
      {cs.stage === 'dispatched' && crew && (
        <CrewBox c={c} cs={cs} crew={crew} now={props.now} timeZone={props.timeZone} awaiting={props.awaiting}
          onReroute={props.onReroute} onReassign={props.onReassign} />
      )}
    </div>
  );
}

export function CallerList(props: Props) {
  const { callers, streets, now, timeZone, synthetic, selectedId, cases, onSelect } = props;
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
            <div key={c.id} role="button" tabIndex={0} data-report={c.id} data-stage={cs.stage}
              onClick={() => onSelect(selected ? null : c.id)}
              onKeyDown={(e) => { if (e.key === 'Enter') onSelect(selected ? null : c.id); }}
              className={`cursor-pointer border-b border-ink-800 px-3 py-2 text-left hover:bg-ink-850 ${selected ? 'bg-ink-800' : ''}`}
              style={{ borderLeft: `4px solid ${cs.stage === 'unassigned' ? STAGE_COLOUR.unassigned : URGENCY_COLOUR[urgency]}` }}>
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
              <Actions {...props} c={c} cs={cs} selected={selected} />
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
                      const closure = closureAt(p, now);
                      // Only what is known now: a closure that has happened, or what the forecast in force says.
                      const reachBy = !closure ? forecastReach(street, props.ahead) : null;
                      const soon = closure ? ` · ${closureSource(p, closure)}`
                        : reachBy ? ` · forecast: fire may reach it by ${fmtTime(reachBy.at, timeZone)}` : '';
                      const warn = fireNearby(p, now);
                      return (
                        <li key={p.id} className="flex gap-1.5">
                          <span style={{ color: STATUS_COLOUR[st] }}>■</span>
                          <span>
                            {streetLabel(p)}
                            <span className="block font-mono text-ink-400">
                              {p.free_width_m != null ? `${p.free_width_m} m wide · ` : ''}{Math.round(dist)} m away{soon}
                            </span>
                            {warn && <span className="block text-amber-300">⚠ fire nearby (satellite: {p.fire_nearby_source})</span>}
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
