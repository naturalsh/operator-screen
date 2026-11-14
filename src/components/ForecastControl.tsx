import { useState } from 'react';
import { fmtTime } from '../data';
import type { ForecastLoad, ForecastRun, NewObservation } from '../forecast';

interface Props {
  load: ForecastLoad | null;
  /** The load before the one in force (for "was ... km²"). */
  previous: ForecastLoad | null;
  newObs: NewObservation[];
  /** The forecast "Update forecast" would load now (null: none newer than the one in force). */
  updateTo: ForecastRun | null;
  /** The forecast "Re-run with current weather" would load now (same perimeter, later start). */
  rerunTo: ForecastRun | null;
  /** Why neither is possible, e.g. the precomputed forecasts end. */
  blockedNote: string | null;
  sourceKind: 'precomputed' | 'live';
  busy: boolean;
  timeZone: string;
  compact?: boolean;
  onUpdate: (kind: 'update' | 'rerun') => void;
}

const SOURCE_LABEL = { precomputed: 'PRECOMPUTED', live: 'LIVE MODEL' } as const;

/** The forecast in force and the operator's "Update forecast" button (map overlay, top left). */
export function ForecastControl({ load, previous, newObs, updateTo, rerunTo, blockedNote, sourceKind, busy, timeZone, compact, onUpdate }: Props) {
  const [open, setOpen] = useState(!compact);
  const run = load?.run;
  const t = (x: number) => fmtTime(x, timeZone);
  const last = run?.lastObsAt != null ? `${t(run.lastObsAt)} (${run.lastObsLabel})` : null;
  const twelve = (r?: ForecastRun | null) => r?.contours.find((c) => c.horizon === 12)?.areaKm2 ?? r?.contours[r.contours.length - 1]?.areaKm2;
  const badge = newObs.length > 0 ? newObs.length : 0;
  if (compact && !open) {
    return (
      <button data-forecast-control="closed" onClick={() => setOpen(true)}
        className="absolute left-2 top-2 z-10 flex h-9 items-center gap-1.5 rounded-lg border border-ink-600 bg-ink-900/90 px-2.5 text-xs font-bold text-ink-100 shadow">
        Forecast {run ? t(run.issuedAt) : '—'}
        {badge > 0 && <span data-new-obs-badge className="rounded-full bg-sky-500 px-1.5 text-[11px] text-ink-950">{badge} new</span>}
      </button>
    );
  }
  return (
    <div data-forecast-control="open"
      className={`absolute left-2 top-2 z-10 rounded-lg border border-ink-600 bg-ink-900/90 p-2.5 text-xs text-ink-100 shadow-lg backdrop-blur ${compact ? 'w-[min(300px,calc(100%-70px))]' : 'w-[300px]'}`}>
      <div className="mb-1 flex items-center gap-2">
        <span className="font-bold uppercase tracking-wider text-ink-400">Forecast</span>
        <span data-forecast-source className="model-tag" style={{ fontSize: 10, padding: '1px 6px' }}
          title={sourceKind === 'precomputed'
            ? 'Computed in advance with the fire model for every new satellite pass and every 30 minutes; a static site cannot run the model.'
            : 'Computed now by the model server.'}>
          {run?.source === 'live' ? SOURCE_LABEL.live : SOURCE_LABEL.precomputed}
        </span>
        {compact && <button onClick={() => setOpen(false)} aria-label="Close forecast panel" className="ml-auto px-1 text-ink-400">✕</button>}
      </div>
      {run ? (
        <div data-forecast-in-force>
          <div><b>Issued {t(run.issuedAt)}</b> from {run.from.replace(' (no new pass)', '')}</div>
          <div className="text-ink-400">
            {load!.kind === 'opening' && load!.seq === 0 ? 'made at ignition'
              : load!.kind === 'history' ? 'updated at that pass (before this screen opened)' : `loaded ${t(load!.at)}`}
            {last ? ` · last pass used ${last}` : ''}
          </div>
          {load?.label && (
            <div data-forecast-label className="mt-1 rounded bg-ink-800 px-1.5 py-0.5 text-amber-200">
              {load.label}
              {previous && twelve(run) != null && twelve(previous.run) != null
                && ` · +12 h ${twelve(run)!.toFixed(1)} km² (was ${twelve(previous.run)!.toFixed(1)})`}
            </div>
          )}
          {run.sourceNote && <div className="mt-1 text-amber-300">{run.sourceNote}</div>}
        </div>
      ) : <div className="text-ink-400">No forecast yet.</div>}

      <div className="mt-2 border-t border-ink-700 pt-2">
        {badge > 0 ? (
          <>
            <button data-update-forecast disabled={busy || !updateTo} onClick={() => onUpdate('update')}
              className="flex w-full items-center justify-between rounded bg-sky-500 px-2.5 py-1.5 font-bold text-ink-950 disabled:opacity-50">
              <span>Update forecast</span>
              <span data-new-obs-badge className="rounded-full bg-ink-950 px-2 py-0.5 text-[11px] text-sky-300">
                {badge} new observation{badge > 1 ? 's' : ''} since forecast
              </span>
            </button>
            <div className="mt-1 text-ink-400" data-new-obs-list>
              {newObs.slice(-3).map((o) => `${t(o.at)} ${o.label}`).join(' · ')}
            </div>
          </>
        ) : (
          <>
            <div data-no-new-obs className="text-ink-200">
              No new observations since {last ?? (run ? `${t(run.issuedAt)} (ignition)` : 'the start')}
            </div>
            <button data-rerun-forecast disabled={busy || !rerunTo} onClick={() => onUpdate('rerun')}
              title="Same starting area, a later start time and the weather from then on. Not new information about the fire."
              className="mt-1.5 w-full rounded border border-ink-500 px-2.5 py-1.5 font-bold text-ink-100 hover:bg-ink-800 disabled:opacity-50">
              Re-run with current weather{rerunTo ? ` (${t(rerunTo.issuedAt)})` : ''}
            </button>
          </>
        )}
        {blockedNote && <div data-forecast-blocked className="mt-1 text-ink-400">{blockedNote}</div>}
      </div>
    </div>
  );
}
