import { useEffect, useRef, useState } from 'react';
import { fmtTime } from '../data';

/** One event on the time bar: a forecast load (automatic at a pass, or by the operator). */
export interface TimeMark {
  t: number;
  /** 'auto': at a satellite pass; 'operator': loaded with "Update forecast"; 'other': anything else. */
  kind: 'auto' | 'operator' | 'other';
  /** What happened, for the tooltip ("forecast updated: VIIRS N20 pass"). */
  text: string;
}

/** Playback speeds in scenario hours per second of wall time. The slow ones are for watching a vehicle drive. */
export const SPEED_1_MIN = 1 / 60;
export const SPEEDS: [number, string][] = [[SPEED_1_MIN, '1 min/s'], [5 / 60, '5 min/s'], [0.25, '15 min/s'], [0.5, '30 min/s'], [1, '1 h/s'], [3, '3 h/s']];

interface Props {
  start: number;
  end: number;
  now: number;
  playing: boolean;
  speed: number;
  timeZone: string;
  marks: TimeMark[];
  onSeek: (t: number) => void;
  onPlay: (playing: boolean) => void;
  onSpeed: (hoursPerSecond: number) => void;
  /** Phone layout: two rows, touch-sized controls. */
  compact?: boolean;
  /** Phone held sideways: everything on one row. */
  thin?: boolean;
  /** True while the slider is being dragged (the screen can skip expensive work until it is released). */
  onScrub?: (scrubbing: boolean) => void;
}

/** While dragging, the time is passed on at most this often; the final value is passed on release. */
const SCRUB_MS = 120;

const KIND_COLOUR = { auto: '#fde047', operator: '#38bdf8', other: '#cbd5e1' } as const;
/** Marks closer than this on screen are drawn as one (wider than a mark's 14 px touch target). */
const MERGE_PX = 16;
/** Tooltip width (narrower on a phone: never wider than the bar). */
const TIP_W = 280;

interface Group { t: number; x: number; marks: TimeMark[] }

/** Marks grouped so that no two drawn marks are closer than MERGE_PX at the bar's current width. */
export function groupMarks(marks: TimeMark[], start: number, end: number, widthPx: number): Group[] {
  const groups: Group[] = [];
  const px = (t: number) => ((t - start) / (end - start)) * widthPx;
  for (const m of [...marks].sort((a, b) => a.t - b.t)) {
    const last = groups[groups.length - 1];
    if (last && px(m.t) - px(last.marks[last.marks.length - 1].t) < MERGE_PX) last.marks.push(m);
    else groups.push({ t: m.t, x: 0, marks: [m] });
  }
  for (const g of groups) g.x = (px(g.marks[0].t) + px(g.marks[g.marks.length - 1].t)) / 2;
  return groups;
}

/** "3 passes", "2 forecast loads", "forecast updated: VIIRS N20 pass". */
function groupTitle(g: Group): string {
  if (g.marks.length === 1) return g.marks[0].text;
  const auto = g.marks.every((m) => m.kind === 'auto');
  return `${g.marks.length} ${auto ? 'passes' : 'forecast loads'}`;
}

/**
 * Small marks above the slider, no text on the bar: hover (or tap) a mark for a tooltip with its time and what
 * happened. Marks too close to tell apart are merged into one ("3 passes").
 */
function Marks({ start, end, marks, timeZone, height }: { start: number; end: number; marks: TimeMark[]; timeZone: string; height: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  // Opened by a click / tap (stays until tapped again) rather than by the mouse passing over it.
  const pinned = useRef(false);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const groups = width ? groupMarks(marks, start, end, width) : [];
  // A tooltip whose mark went away (the clock moved back) closes.
  useEffect(() => { if (open != null && !groups.some((g) => g.t === open)) setOpen(null); });
  const shown = groups.find((g) => g.t === open);
  return (
    <div ref={box} className="relative" style={{ height }} data-timebar-marks
      onPointerLeave={(e) => { if (e.pointerType === 'mouse' && !pinned.current) setOpen(null); }}>
      {groups.map((g) => {
        const kinds = new Set(g.marks.map((m) => m.kind));
        const colour = kinds.size === 1 ? KIND_COLOUR[g.marks[0].kind] : '#e2e8f0';
        const many = g.marks.length > 1;
        return (
          <button key={g.t} type="button" data-timebar-mark data-t={g.t} data-count={g.marks.length}
            aria-label={`${fmtTime(g.t, timeZone)}: ${groupTitle(g)}`}
            onPointerEnter={(e) => { if (e.pointerType === 'mouse') { pinned.current = false; setOpen(g.t); } }}
            onBlur={() => setOpen(null)}
            onClick={() => { const close = open === g.t && pinned.current; pinned.current = !close; setOpen(close ? null : g.t); }}
            className="absolute top-0 -translate-x-1/2 p-0" style={{ left: g.x, width: 14, height }}>
            <span className="mx-auto block rounded-sm" style={{ width: many ? 6 : 3, height: Math.min(height, 10), background: colour,
              boxShadow: many ? `0 0 0 1px #07090d, 0 0 0 2px ${colour}` : undefined }} />
          </button>
        );
      })}
      {shown && (
        <div role="tooltip" data-timebar-tooltip
          className="pointer-events-none absolute bottom-full z-30 mb-1 rounded border border-ink-600 bg-ink-900 px-2 py-1 text-[11px] leading-snug text-ink-100 shadow-lg"
          style={{ width: Math.min(TIP_W, width), left: Math.min(Math.max(shown.x - TIP_W / 2, 0), Math.max(0, width - TIP_W)) }}>
          <div className="font-bold">{groupTitle(shown)}</div>
          {shown.marks.map((m, i) => (
            <div key={`${m.t}-${i}`}>
              <span style={{ color: KIND_COLOUR[m.kind] }}>■</span> {fmtTime(m.t, timeZone)} · {m.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function TimeBar({ start, end, now: applied, playing, speed, timeZone, marks, onSeek, onPlay, onSpeed, compact, thin, onScrub }: Props) {
  // Dragging: the thumb and the clock follow the finger at once; the screen gets the time at most every SCRUB_MS
  // (a phone cannot redraw the map at every input event) and the exact value on release.
  const [drag, setDrag] = useState<number | null>(null);
  const dragging = useRef(false);
  const pending = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = () => {
    timer.current = null;
    if (pending.current != null) { onSeek(pending.current); pending.current = null; }
  };
  const begin = () => { if (!dragging.current) { dragging.current = true; onScrub?.(true); } };
  const end_ = () => {
    if (!dragging.current) return;
    dragging.current = false;
    if (timer.current) clearTimeout(timer.current);
    flush();
    setDrag(null);
    onScrub?.(false);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const change = (v: number) => {
    if (!dragging.current) { onSeek(v); return; }       // keyboard, or a tap on the track: apply at once
    setDrag(v);
    pending.current = v;
    if (!timer.current) timer.current = setTimeout(flush, SCRUB_MS);
  };
  const now = drag ?? applied;
  const slider = (cls: string) => (
    <input type="range" className={cls} min={start} max={end} step={60000} value={now}
      aria-label="Scenario time" data-scrubbing={drag != null ? 'true' : undefined}
      onPointerDown={begin} onTouchStart={begin} onPointerUp={end_} onTouchEnd={end_} onPointerCancel={end_} onTouchCancel={end_}
      onBlur={end_} onChange={(e) => change(Number(e.target.value))} />
  );
  const speedSelect = (cls: string) => (
    <select value={speed} onChange={(e) => onSpeed(Number(e.target.value))} aria-label="Playback speed" className={cls}>
      {SPEEDS.map(([v, label]) => <option key={label} value={v}>{label}</option>)}
    </select>
  );
  if (compact && thin) {
    return (
      <div className="flex items-center gap-2 border-t border-ink-700 bg-ink-900 px-2" data-timebar="thin"
        style={{ height: 48, paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <button onClick={() => onPlay(!playing)} aria-label={playing ? 'Pause' : 'Play'}
          className="h-10 w-11 shrink-0 rounded bg-ink-700 text-base active:bg-ink-600">{playing ? '❚❚' : '▶'}</button>
        <button onClick={() => { onPlay(false); onSeek(start); }} aria-label="Back to start"
          className="h-10 w-10 shrink-0 rounded bg-ink-800 text-xs text-ink-200 active:bg-ink-700">|◀</button>
        <div className="shrink-0 font-mono text-[12px] leading-tight">
          <div className="whitespace-nowrap">{fmtTime(now, timeZone)} <span className="text-[10px] text-ink-400">local</span></div>
          <div className="whitespace-nowrap text-[10px] text-ink-400">{fmtTime(now, 'UTC')} UTC</div>
        </div>
        <div className="relative min-w-0 flex-1">
          {/* No room for a row of its own: the marks sit just above the track. */}
          <div className="absolute inset-x-0 -top-1.5"><Marks start={start} end={end} marks={marks} timeZone={timeZone} height={8} /></div>
          {slider('touch-range w-full')}
        </div>
        {speedSelect('h-10 shrink-0 rounded bg-ink-800 px-1 text-sm text-ink-50')}
      </div>
    );
  }
  if (compact) {
    return (
      <div className="border-t border-ink-700 bg-ink-900 px-3 pt-1.5" data-timebar="compact"
        style={{ paddingBottom: 'max(6px, env(safe-area-inset-bottom))' }}>
        <Marks start={start} end={end} marks={marks} timeZone={timeZone} height={14} />
        {slider('touch-range w-full')}
        <div className="flex items-center gap-2">
          <button onClick={() => onPlay(!playing)} aria-label={playing ? 'Pause' : 'Play'}
            className="h-11 w-11 shrink-0 rounded bg-ink-700 text-lg active:bg-ink-600">{playing ? '❚❚' : '▶'}</button>
          <button onClick={() => { onPlay(false); onSeek(start); }} aria-label="Back to start"
            className="h-11 w-11 shrink-0 rounded bg-ink-800 text-xs text-ink-200 active:bg-ink-700">|◀</button>
          <div className="min-w-0 flex-1 font-mono text-[13px] leading-tight">
            <div className="whitespace-nowrap">{fmtTime(now, timeZone)} <span className="text-[10px] text-ink-400">local</span></div>
            <div className="whitespace-nowrap text-[11px] text-ink-400">{fmtTime(now, 'UTC')} UTC</div>
          </div>
          {speedSelect('h-11 shrink-0 rounded bg-ink-800 px-1 text-sm text-ink-50')}
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 border-t border-ink-700 bg-ink-900 px-3 py-2" data-timebar="full">
      <button onClick={() => onPlay(!playing)} aria-label={playing ? 'Pause' : 'Play'}
        className="h-9 w-9 rounded bg-ink-700 text-lg hover:bg-ink-600">{playing ? '❚❚' : '▶'}</button>
      <button onClick={() => { onPlay(false); onSeek(start); }} aria-label="Back to start"
        className="h-9 rounded bg-ink-800 px-2 text-xs text-ink-200 hover:bg-ink-700">|◀ start</button>
      <div className="w-44 font-mono text-sm leading-tight">
        <div>{fmtTime(now, timeZone)} <span className="text-ink-400">local</span></div>
        <div className="text-[11px] text-ink-400">{fmtTime(now, 'UTC')} UTC</div>
      </div>
      <div className="flex-1">
        <Marks start={start} end={end} marks={marks} timeZone={timeZone} height={12} />
        {slider('w-full')}
      </div>
      <label className="text-xs text-ink-400">
        speed{' '}
        {speedSelect('rounded bg-ink-800 px-1 py-1 text-ink-50')}
      </label>
    </div>
  );
}
