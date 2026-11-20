import { useState } from 'react';
import { fmtTime } from '../data';
import { autoLabel, nowcastSource, type ForecastLoad, type ForecastRun, type Nowcast } from '../forecast';

interface Props {
  load: ForecastLoad | null;
  /** The load before the one in force (for "was ... km²"). */
  previous: ForecastLoad | null;
  /** What "Update forecast" loads now (null: nothing can be issued, see `blockedNote`). */
  updateTo: ForecastRun | null;
  /** Why the button cannot load anything, e.g. after the end of the precomputed forecasts. */
  blockedNote: string | null;
  /** Validation/service error from the live model; shown without replacing the current safe forecast. */
  error?: string | null;
  /** CONCEPT DEMO: confirmed reports the forecast in force does not have yet. */
  newReports?: number;
  sourceKind: 'precomputed' | 'live';
  busy: boolean;
  timeZone: string;
  compact?: boolean;
  /** "Fire now (estimated)" at the time shown. */
  nowcast?: Nowcast | null;
  /** The in-browser model: loading / ready / failed, and the runs done of a computation in progress. */
  modelState?: 'off' | 'loading' | 'ready' | 'failed';
  modelBusy?: { done: number; total: number } | null;
  /** A pass reached whose automatic update (with operator fires) is being computed in this browser: what it uses. */
  autoUpdating?: string | null;
  onUpdate: () => void;
}

const SOURCE_LABEL = { precomputed: 'PRECOMPUTED', live: 'LIVE MODEL', browser: 'LIVE IN BROWSER' } as const;

/** "Last updated 04:02 from VIIRS N20" and the like: when and why the forecast in force was loaded. */
export function lastUpdated(load: ForecastLoad, t: (x: number) => string): string {
  const run = load.run;
  if (load.kind === 'opening') return `Made at ignition, ${t(run.issuedAt)}`;
  if (load.kind === 'auto' && run.source === 'browser') {
    const n = (run as { operatorFires?: string[] }).operatorFires?.length ?? 0;
    return `Auto-updated ${t(load.at).split(', ')[1]} · ${run.lastObsLabel ?? 'satellite'} + ${n} operator-confirmed fire${n > 1 ? 's' : ''}`;
  }
  if (load.kind === 'auto') return `Last updated ${t(load.at)} from ${run.lastObsLabel ?? 'the latest pass'}`;
  if (run.source === 'browser') {
    const n = (run as { operatorFires?: string[] }).operatorFires?.length ?? 0;
    const note = (run as { browserNote?: string }).browserNote;
    const clock = (x: number) => t(x).split(', ')[1];
    return `Last updated ${clock(load.at)} · ${run.lastObsAt != null ? `satellite ${clock(run.lastObsAt)}` : 'ignition point'}`
      + (n ? ` + ${n} operator-confirmed fire${n > 1 ? 's' : ''}` : note ? ` + model · ${note}` : ' + model (re-run)');
  }
  return `Last updated ${t(load.at)} by the operator`;
}

/**
 * The forecast in force and the operator's "Update forecast" button (map overlay, top left). The forecast updates
 * itself at every new satellite pass; the button re-runs it with the weather at the time shown.
 */
export function ForecastControl({ load, previous, updateTo, blockedNote, error, newReports = 0, sourceKind, busy, timeZone, compact, nowcast, modelState = 'off', modelBusy, autoUpdating, onUpdate }: Props) {
  const [open, setOpen] = useState(!compact);
  const run = load?.run;
  const t = (x: number) => fmtTime(x, timeZone);
  const six = (r?: ForecastRun | null) => r?.contours.find((c) => c.horizon === 6)?.areaKm2 ?? r?.contours[r.contours.length - 1]?.areaKm2;
  if (compact && !open) {
    return (
      <div className="absolute left-2 top-2 z-10 flex items-center gap-1.5">
        <button data-forecast-control="closed" data-forecast-run={run?.id ?? ''} data-forecast-issued={run?.issuedAt ?? ''} onClick={() => setOpen(true)}
          className="flex h-9 items-center gap-1.5 rounded-lg border border-ink-600 bg-ink-900/90 px-2.5 text-xs font-bold text-ink-100 shadow">
          Forecast {load ? t(load.at) : '—'}
          {load?.kind === 'auto' && <span className="rounded-full bg-ink-700 px-1.5 text-[10px] font-normal text-ink-200">auto</span>}
        </button>
        {/* Update forecast without opening the box (the box, opened, says what it does and what came of it). */}
        <button data-update-forecast="compact" disabled={busy || !updateTo} onClick={onUpdate} aria-label="Update forecast"
          title="Update forecast: computed now in this browser, with the current weather"
          className="h-9 rounded-lg bg-sky-500 px-2.5 text-xs font-bold text-ink-950 shadow disabled:opacity-50">
          {busy || modelBusy || autoUpdating ? 'Updating…' : 'Update'}
        </button>
      </div>
    );
  }
  const what = newReports > 0
    ? `with ${newReports} confirmed report${newReports > 1 ? 's' : ''} (CONCEPT DEMO)`
    : modelState === 'ready' ? 'computed now in this browser, with the current weather'
      : `re-run with current weather at ${updateTo ? t(updateTo.issuedAt) : '—'} (precomputed)`;
  return (
    <div data-forecast-control="open" data-forecast-run={run?.id ?? ''} data-forecast-issued={run?.issuedAt ?? ''}
      className={`absolute left-2 top-2 z-10 rounded-lg border border-ink-600 bg-ink-900/90 p-2.5 text-xs text-ink-100 shadow-lg backdrop-blur ${compact ? 'w-[min(300px,calc(100%-70px))]' : 'w-[300px]'}`}>
      <div className="mb-1 flex items-center gap-2">
        <span className="font-bold uppercase tracking-wider text-ink-400">Forecast</span>
        <span data-forecast-source className="model-tag" style={{ fontSize: 10, padding: '1px 6px' }}
          title={sourceKind === 'precomputed'
            ? 'Computed in advance with the fire model for every new satellite pass and every 30 minutes; a static site cannot run the model.'
            : 'Computed now by the model server.'}>
          {SOURCE_LABEL[run?.source ?? 'precomputed']}
        </span>
        {compact && <button onClick={() => setOpen(false)} aria-label="Close forecast panel" className="ml-auto px-1 text-ink-400">✕</button>}
      </div>
      {run && load ? (
        <div data-forecast-in-force>
          <div data-forecast-last-updated={load.kind}><b>{lastUpdated(load, t)}</b></div>
          <div className="text-ink-400">
            issued {t(run.issuedAt)} from {run.from}
          </div>
          {load.label && (
            <div data-forecast-label className="mt-1 rounded bg-ink-800 px-1.5 py-0.5 text-amber-200">
              {load.label}
              {load.note ? <span data-forecast-note> · {load.note}</span>
                : previous && six(run) != null && six(previous.run) != null
                && ` · +6 h ${six(run)!.toFixed(1)} km² (was ${six(previous.run)!.toFixed(1)})`}
            </div>
          )}
          {run.sourceNote && <div className="mt-1 text-amber-300">{run.sourceNote}</div>}
          <div data-forecast-confidence className="mt-1 text-ink-300">
            Prediction confidence: {run.confidence == null
              ? `not available (${run.confidenceReason ?? 'the model supplied no uncertainty estimate'})`
              : `${Math.round(run.confidence * 100)}% ensemble agreement`}
          </div>
          {nowcast && (
            <div data-observed className="mt-1.5 flex gap-1.5 px-1.5">
              <span className="mt-1.5 h-0.5 w-3 shrink-0 bg-white" />
              <span>{nowcast.observed
                ? <><b>Seen by satellite</b> {t(nowcast.observed.at)} ({nowcast.observed.label}): observed edge, white line.</>
                : <span className="text-ink-400">No satellite pass yet: nothing observed.</span>}</span>
            </div>
          )}
          {nowcast && (
            <div data-nowcast className="mt-1.5 flex gap-1.5 rounded bg-ink-800 px-1.5 py-1">
              <span className="mt-0.5 h-3 w-3 shrink-0 rounded-sm border-2" style={{ background: '#2a1a14', borderColor: '#f0532b' }} />
              <span>
                <b>Fire now (model estimate)</b> for {t(nowcast.stepAt)}: {nowcastSource(nowcast.run, t)}.
                {nowcast.beyond.length > 0 && (
                  <span className="text-ink-400"> +{nowcast.beyond.join(' / +')} h beyond this forecast's 12 h.</span>
                )}
              </span>
            </div>
          )}
        </div>
      ) : <div className="text-ink-400">No forecast yet.</div>}

      <div className="mt-2 border-t border-ink-700 pt-2">
        <button data-update-forecast disabled={busy || !updateTo} onClick={onUpdate}
          title="Runs the forecast again from the fire estimated now, with the weather from now on. New satellite passes update it automatically."
          className="flex w-full flex-col items-start rounded bg-sky-500 px-2.5 py-1.5 text-left font-bold text-ink-950 hover:bg-sky-400 disabled:opacity-50">
          <span>Update forecast</span>
          <span data-update-what className="text-[11px] font-normal">{what}</span>
        </button>
        {autoUpdating && (
          <div data-auto-updating className="mt-1 text-orange-200">Auto-updating in this browser: {autoUpdating}…</div>
        )}
        {modelBusy && (
          <div data-model-busy className="mt-1 text-orange-200">Computing in this browser… {modelBusy.done}/{modelBusy.total} runs</div>
        )}
        {modelState === 'failed' && <div className="mt-1 text-amber-300">The browser model could not load: precomputed forecasts only.</div>}
        {error && <div role="alert" data-forecast-error className="mt-1 rounded bg-rose-950/70 px-1.5 py-1 text-rose-200">{error}</div>}
        <div className="mt-1 text-ink-400" data-auto-note>
          Updates automatically at each new VIIRS or Sentinel-2 pass{load?.kind === 'auto' ? ` (last: ${autoLabel(load.run).replace('new ', '')}, ${t(load.at)})` : ''}.
        </div>
        {blockedNote && <div data-forecast-blocked className="mt-1 text-ink-400">{blockedNote}</div>}
      </div>
    </div>
  );
}
