import { useEffect, useState } from 'react';
import { fmtTime } from '../data';
import { MAX_OBSERVED_AGO_MIN, SIZE_LABEL, SOURCE_LABEL, type FireSize, type FireSource } from '../fires';

interface Props {
  /** Points clicked on the map so far (one: a point; three or more: an area can be drawn). */
  vertices: [number, number][];
  now: number;
  timeZone: string;
  compact?: boolean;
  onConfirm: (meta: { source: FireSource; size: FireSize; observedAt: number; note: string }) => void;
  onUndo: () => void;
  onCancel: () => void;
}

/** The "Add fire" box: what the operator knows about a fire they confirm. */
export function AddFireDialog({ vertices, now, timeZone, compact, onConfirm, onUndo, onCancel }: Props) {
  const [source, setSource] = useState<FireSource>('crew');
  const [size, setSize] = useState<FireSize>('100m');
  const [ago, setAgo] = useState(0);
  const [note, setNote] = useState('');
  const canDraw = vertices.length >= 3;
  // Three clicks or more: the drawn area is the natural choice; fewer: it is not possible.
  useEffect(() => { if (canDraw) setSize('drawn'); else if (size === 'drawn') setSize('100m'); }, [canDraw]); // eslint-disable-line react-hooks/exhaustive-deps
  const t = (x: number) => fmtTime(x, timeZone);
  return (
    <div data-add-fire-dialog role="dialog" aria-label="Add an operator-confirmed fire"
      className={`absolute z-30 rounded-lg border border-orange-400 bg-ink-900/95 p-3 text-xs text-ink-100 shadow-2xl ${compact ? 'inset-x-2 bottom-14' : 'bottom-2 left-2 w-[340px]'}`}>
      <div className="mb-1 flex items-center gap-2">
        <b className="text-orange-200">Add an operator-confirmed fire</b>
        <span className="ml-auto text-ink-400">{vertices.length ? `${vertices.length} point${vertices.length > 1 ? 's' : ''} on the map` : 'click the map'}</span>
      </div>
      <p className="mb-2 text-ink-400">
        {vertices.length === 0 ? 'Click the map where the fire is; click more points to draw its area.'
          : canDraw ? 'Area drawn. More clicks add corners.' : 'Click two more points to draw an area, or pick a size.'}
      </p>
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5">
        <label htmlFor="af-source" className="text-ink-400">Source</label>
        <select id="af-source" data-af-source value={source} onChange={(e) => setSource(e.target.value as FireSource)}
          className="rounded bg-ink-800 px-1 py-1 text-ink-50">
          {(Object.keys(SOURCE_LABEL) as FireSource[]).map((k) => <option key={k} value={k}>{SOURCE_LABEL[k]}</option>)}
        </select>
        <label htmlFor="af-time" className="text-ink-400">Seen at</label>
        <select id="af-time" data-af-time value={ago} onChange={(e) => setAgo(Number(e.target.value))}
          className="rounded bg-ink-800 px-1 py-1 text-ink-50">
          {Array.from({ length: MAX_OBSERVED_AGO_MIN / 5 + 1 }, (_, i) => i * 5).map((m) => (
            <option key={m} value={m}>{m === 0 ? `now (${t(now)})` : `${t(now - m * 60000)} (${m} min ago)`}</option>
          ))}
        </select>
        <span className="text-ink-400">Size</span>
        <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Size">
          {(Object.keys(SIZE_LABEL) as FireSize[]).map((k) => (
            <button key={k} type="button" data-af-size={k} aria-pressed={size === k} disabled={k === 'drawn' && !canDraw} onClick={() => setSize(k)}
              className={`rounded border px-1.5 py-0.5 ${size === k ? 'border-orange-300 bg-orange-400 font-bold text-ink-950' : 'border-ink-600 text-ink-200'} disabled:opacity-40`}>
              {SIZE_LABEL[k]}
            </button>
          ))}
        </div>
        <label htmlFor="af-note" className="text-ink-400">Note</label>
        <input id="af-note" data-af-note value={note} onChange={(e) => setNote(e.target.value)} maxLength={120} placeholder="e.g. flames on the ridge above the road"
          className="rounded bg-ink-800 px-1.5 py-1 text-ink-50" />
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <button data-af-confirm disabled={!vertices.length} onClick={() => onConfirm({ source, size, observedAt: now - ago * 60000, note: note.trim() })}
          className="rounded bg-orange-400 px-3 py-1.5 font-bold text-ink-950 disabled:opacity-40">Confirm</button>
        {vertices.length > 0 && <button onClick={onUndo} className="rounded border border-ink-600 px-2 py-1.5 text-ink-200">Undo point</button>}
        <button data-af-cancel onClick={onCancel} className="ml-auto rounded border border-ink-600 px-2 py-1.5 text-ink-200">Cancel</button>
      </div>
      <p className="mt-1.5 text-[10px] text-ink-400">Confirm adds it to the decision log and recomputes the forecast in this browser
        (from the fire estimated now plus every operator-confirmed fire).</p>
    </div>
  );
}
