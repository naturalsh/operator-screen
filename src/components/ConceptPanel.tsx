import { fmtTime } from '../data';
import { CONCEPT_LABEL, DISTANCE_LABEL, LOCATION_LABEL, STATEMENT_LABEL, type ClusterState } from '../reports';
import type { ConceptScore } from '../types';

interface Props {
  clusters: ClusterState[];
  /** Clusters the forecast in force was started with. */
  inForecast: string[];
  /** Scores whose satellite pass is not later than the time shown. */
  scores: ConceptScore[];
  reportsUntil: number;
  now: number;
  timeZone: string;
  onConfirm: (clusterId: string) => void;
  /** Rendered by item 3 ("Is the fire still there?"); optional. */
  extra?: (c: ClusterState) => React.ReactNode;
}

/** CONCEPT DEMO: fire reports from people, their clusters, the operator's confirmation and the after-the-fact score. */
export function ConceptPanel({ clusters, inForecast, scores, reportsUntil, now, timeZone, onConfirm, extra }: Props) {
  const t = (x: number) => fmtTime(x, timeZone);
  const candidates = clusters.filter((c) => c.candidate);
  const singles = clusters.filter((c) => !c.candidate);
  const lastIssue = scores.length ? scores[scores.length - 1].issued_at : null;
  const shown = scores.filter((s) => s.issued_at === lastIssue);
  return (
    <section className="border-b border-ink-700 p-3" data-concept-panel>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-xs font-bold uppercase tracking-wider text-ink-400">Fire reports</h2>
        <span className="concept-tag" title={CONCEPT_LABEL}>CONCEPT DEMO</span>
      </div>
      <p className="mb-2 text-[11px] leading-snug text-violet-200" data-concept-label>{CONCEPT_LABEL}. An upper bound: real
        callers are fewer, later and less precise. Not part of the overlap table.</p>
      {!clusters.length && <p className="text-xs text-ink-400">No fire reports yet.</p>}
      {candidates.map((c) => (
        <div key={c.cluster.id} data-cluster={c.cluster.id} data-candidate
          className="mb-2 rounded border border-dashed border-violet-400/70 bg-violet-950/30 p-2 text-xs">
          <div className="flex items-center gap-2">
            <b className="text-violet-200">{c.confirmedAt != null ? 'REPORTED (confirmed)' : 'REPORTED (unconfirmed)'}</b>
            <span className="ml-auto font-mono">P {c.p.toFixed(2)}</span>
          </div>
          <div className="text-ink-200">{c.sources} independent source{c.sources === 1 ? '' : 's'} · {c.reports.length} report{c.reports.length === 1 ? '' : 's'}
            · {c.reports[0].place.label}</div>
          <ul className="mt-1 space-y-0.5 text-[11px] text-ink-400">
            {c.reports.map((r) => (
              <li key={r.id}>{t(Date.parse(r.observed_at))} · {STATEMENT_LABEL[r.statement_class]} · {LOCATION_LABEL[r.location_quality]}
                · {DISTANCE_LABEL[r.observer_distance]} · {r.language.toUpperCase()} {r.channel}
                {r.repeat_of_number ? ' · same number again (not independent)' : ''}</li>
            ))}
          </ul>
          {c.confirmedAt == null ? (
            <button data-confirm-report onClick={() => onConfirm(c.cluster.id)}
              className="mt-1.5 rounded bg-violet-500 px-2.5 py-1 font-bold text-ink-950 hover:bg-violet-400">
              Confirm (use in the next update)
            </button>
          ) : (
            <div className="mt-1 text-violet-200" data-confirmed>
              Confirmed {t(c.confirmedAt)} · {inForecast.includes(c.cluster.id) ? 'in the forecast in force'
                : now > reportsUntil ? 'reports are only used in forecasts of the first night'
                : 'goes into the next "Update forecast"'}
            </div>
          )}
          {extra?.(c)}
        </div>
      ))}
      {singles.length > 0 && (
        <p className="text-[11px] text-ink-400" data-single-reports>
          {singles.length} more place{singles.length === 1 ? '' : 's'} with reports below the threshold (one independent source,
          or P &lt; 0.5): shown as small points, not candidates.
        </p>
      )}
      {shown.length > 0 && (
        <div className="mt-2" data-concept-score>
          <p className="mb-1 text-[11px] text-ink-400">
            Score after the fact: forecasts issued {t(Date.parse(shown[0].issued_at))} vs the VIIRS pass at {t(Date.parse(shown[0].next_pass_at))}
          </p>
          <table className="w-full text-[11px]">
            <thead className="text-ink-400"><tr><th className="text-left font-normal">Forecast</th><th className="font-normal">new fire inside</th><th className="font-normal">area</th><th className="font-normal">added area seen burning</th></tr></thead>
            <tbody>
              {shown.map((s) => (
                <tr key={s.variant} className={s.false_reports ? 'text-rose-300' : ''}>
                  <td>{s.variant}</td>
                  <td className="text-center font-mono">{s.new_detections_inside_pct ?? '–'} %</td>
                  <td className="text-center font-mono">{s.forecast_km2} km²</td>
                  <td className="text-center font-mono">{s.added_seen_burning_pct ?? '–'} %</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-[10px] text-ink-400">"New fire inside": of the {shown[0].new_detections} VIIRS detections on new ground, the share
            inside the forecast. Full table: docs/concept_reports.md.</p>
        </div>
      )}
    </section>
  );
}
