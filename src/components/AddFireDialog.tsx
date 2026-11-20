import { useState } from 'react';
import { fmtTime } from '../data';
import { MAX_OBSERVED_AGO_MIN, MIN_DRAWN_POINTS, SIZE_LABEL, SOURCE_LABEL, type FireSize, type FireSource } from '../fires';

interface Props {
  /** Points clicked on the map so far (one: a point; two: a fire line; three or more: an area). */
  vertices: [number, number][];
  /** The size chosen. Point / about 100 m / about 500 m: one point, a new click moves it. Drawn area (only when
   *  picked): every click adds a corner. App keeps it, so the map can preview what Confirm adds. */
  size: FireSize;
  onSize: (s: FireSize) => void;
  /** Corners cleared by leaving the drawn area (said once in the box), 0 = none. */
  cleared?: number;
  /** The corners were tapped in an order whose lines cross: the area uses them in order around their middle. */
  reordered?: boolean;
  /** Where the fire lies against the fire model's area (outlined on the map while the box is open). */
  inModel?: 'inside' | 'partly' | 'outside' | 'unknown';
  now: number;
  timeZone: string;
  compact?: boolean;
  onConfirm: (meta: { source: FireSource; size: FireSize; observedAt: number; note: string }) => void;
  onUndo: () => void;
  onCancel: () => void;
}

/** The "Add fire" box: what the operator knows about a fire they confirm. */
export function AddFireDialog({ vertices, size, onSize, cleared = 0, reordered = false, inModel = 'unknown', now, timeZone, compact, onConfirm, onUndo, onCancel }: Props) {
  const [source, setSource] = useState<FireSource>('crew');
  const [ago, setAgo] = useState(0);
  const [note, setNote] = useState('');
  const n = vertices.length;
  const area = size === 'drawn';
  const t = (x: number) => fmtTime(x, timeZone);
  return (
    <div data-add-fire-dialog role="dialog" aria-label="Add an operator-confirmed fire"
      className={`absolute z-30 rounded-lg border border-orange-400 bg-ink-900/95 p-3 text-xs text-ink-100 shadow-2xl ${compact ? 'inset-x-2 bottom-14' : 'bottom-2 left-2 w-[340px]'}`}>
      <div className="mb-1 flex items-center gap-2">
        <b className="text-orange-200">Add an operator-confirmed fire</b>
        <span className="ml-auto text-ink-400">{area ? `${n} corner${n === 1 ? '' : 's'}` : n ? 'placed' : 'not placed yet'}</span>
      </div>
      <p data-af-hint className="mb-2 text-ink-400">
        {area
          ? `Click to add corners.${n < 3 ? ` ${n === 2 ? 'Two corners: a fire line 60 m wide; a third makes an area.' : 'Three or more make an area (two: a fire line).'}` : ''}`
          : 'Click to place the fire; click again to move it.'}
      </p>
      {reordered && (
        <p data-af-reordered className="mb-2 rounded bg-amber-950/60 px-1.5 py-1 text-amber-200">
          The lines between your corners crossed: the area uses the same corners in order around their middle. Check the shape on the map.
        </p>
      )}
      {(inModel === 'outside' || inModel === 'partly') && (
        <p role={inModel === 'outside' ? 'alert' : undefined} data-af-outside={inModel} className="mb-2 rounded bg-amber-950/60 px-1.5 py-1 text-amber-200">
          {inModel === 'outside' ? 'Outside the fire model\'s area (dashed line on the map): simulation cannot start. Place the ignition inside the model grid.'
            : 'Partly outside the fire model\'s area (dashed line on the map): only the part inside is spread.'}
        </p>
      )}
      {cleared > 0 && !area && (
        <p data-af-cleared className="mb-2 rounded bg-amber-950/60 px-1.5 py-1 text-amber-200">
          Drawn area removed ({cleared} corners): the first corner is now the fire's place. Click to move it.
        </p>
      )}
      {/* Phones: source and time share a row, so the box leaves more of the map free to place the fire on. */}
      <div className={`grid items-center gap-x-2 gap-y-1.5 ${compact ? 'grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1.3fr)]' : 'grid-cols-[auto_1fr]'}`}>
        <label htmlFor="af-source" className="text-ink-400">Source</label>
        <select id="af-source" data-af-source value={source} onChange={(e) => setSource(e.target.value as FireSource)}
          className="min-w-0 rounded bg-ink-800 px-1 py-1 text-ink-50">
          {(Object.keys(SOURCE_LABEL) as FireSource[]).map((k) => <option key={k} value={k}>{SOURCE_LABEL[k]}</option>)}
        </select>
        <label htmlFor="af-time" className="text-ink-400">Seen at</label>
        <select id="af-time" data-af-time value={ago} onChange={(e) => setAgo(Number(e.target.value))}
          className="min-w-0 rounded bg-ink-800 px-1 py-1 text-ink-50">
          {Array.from({ length: MAX_OBSERVED_AGO_MIN / 5 + 1 }, (_, i) => i * 5).map((m) => (
            <option key={m} value={m}>{m === 0 ? `now (${t(now)})` : `${t(now - m * 60000)} (${m} min ago)`}</option>
          ))}
        </select>
        <span className="text-ink-400">Size</span>
        <div className={`flex flex-wrap gap-1 ${compact ? 'col-span-3' : ''}`} role="radiogroup" aria-label="Size">
          {(Object.keys(SIZE_LABEL) as FireSize[]).map((k) => (
            <button key={k} type="button" data-af-size={k} aria-pressed={size === k} onClick={() => onSize(k)}
              className={`rounded border px-1.5 py-0.5 ${size === k ? 'border-orange-300 bg-orange-400 font-bold text-ink-950' : 'border-ink-600 text-ink-200'} disabled:opacity-40`}>
              {SIZE_LABEL[k]}
            </button>
          ))}
        </div>
        <span />
        <span data-af-size-note className={`text-[10px] text-ink-400 ${compact ? 'col-span-3' : ''}`}>Sizes are across the fire (diameter){compact ? '' : '; a point is one 60 m model cell'}.</span>
        <label htmlFor="af-note" className="text-ink-400">Note</label>
        <input id="af-note" data-af-note value={note} onChange={(e) => setNote(e.target.value)} maxLength={120} placeholder="e.g. flames on the ridge above the road"
          className={`rounded bg-ink-800 px-1.5 py-1 text-ink-50 ${compact ? 'col-span-3' : ''}`} />
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <button data-af-confirm disabled={(area ? n < MIN_DRAWN_POINTS : !n) || inModel === 'outside'} onClick={() => onConfirm({ source, size, observedAt: now - ago * 60000, note: note.trim() })}
          className="rounded bg-orange-400 px-3 py-1.5 font-bold text-ink-950 disabled:opacity-40">Confirm</button>
        {n > 0 && <button data-af-undo onClick={onUndo} className="rounded border border-ink-600 px-2 py-1.5 text-ink-200">{area ? 'Undo corner' : 'Remove point'}</button>}
        <button data-af-cancel onClick={onCancel} className="ml-auto rounded border border-ink-600 px-2 py-1.5 text-ink-200">Cancel</button>
      </div>
      {!compact && (
        <p className="mt-1.5 text-[10px] text-ink-400">Confirm adds it to the decision log and recomputes the forecast in this browser
          (from the fire estimated now plus every operator-confirmed fire).</p>
      )}
    </div>
  );
}
