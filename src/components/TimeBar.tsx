import { fmtTime } from '../data';

interface Props {
  start: number;
  end: number;
  now: number;
  playing: boolean;
  speed: number;
  timeZone: string;
  marks: { t: number; label: string; colour: string }[];
  onSeek: (t: number) => void;
  onPlay: (playing: boolean) => void;
  onSpeed: (hoursPerSecond: number) => void;
  /** Phone layout: two rows, touch-sized controls. */
  compact?: boolean;
}

export function TimeBar({ start, end, now, playing, speed, timeZone, marks, onSeek, onPlay, onSpeed, compact }: Props) {
  if (compact) {
    return (
      <div className="border-t border-ink-700 bg-ink-900 px-3 pt-1.5" data-timebar="compact"
        style={{ paddingBottom: 'max(6px, env(safe-area-inset-bottom))' }}>
        <div className="relative pt-3">
          {marks.map((m, i) => (
            <span key={i} className={`absolute top-0 whitespace-nowrap text-[10px] ${m.label && i === 0 ? '' : '-translate-x-1/2'}`}
              style={{ left: `${(100 * (m.t - start)) / (end - start)}%`, color: m.colour }}>▼{m.label ? ` ${m.label}` : ''}</span>
          ))}
          <input type="range" className="touch-range w-full" min={start} max={end} step={600000} value={now}
            aria-label="Scenario time" onChange={(e) => onSeek(Number(e.target.value))} />
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => onPlay(!playing)} aria-label={playing ? 'Pause' : 'Play'}
            className="h-11 w-11 shrink-0 rounded bg-ink-700 text-lg active:bg-ink-600">{playing ? '❚❚' : '▶'}</button>
          <button onClick={() => { onPlay(false); onSeek(start); }} aria-label="Back to start"
            className="h-11 w-11 shrink-0 rounded bg-ink-800 text-xs text-ink-200 active:bg-ink-700">|◀</button>
          <div className="min-w-0 flex-1 font-mono text-[13px] leading-tight">
            <div className="whitespace-nowrap">{fmtTime(now, timeZone)} <span className="text-[10px] text-ink-400">local</span></div>
            <div className="whitespace-nowrap text-[11px] text-ink-400">{fmtTime(now, 'UTC')} UTC</div>
          </div>
          <select value={speed} onChange={(e) => onSpeed(Number(e.target.value))} aria-label="Playback speed"
            className="h-11 shrink-0 rounded bg-ink-800 px-1 text-sm text-ink-50">
            <option value={0.5}>30 min/s</option>
            <option value={1}>1 h/s</option>
            <option value={3}>3 h/s</option>
          </select>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 border-t border-ink-700 bg-ink-900 px-3 py-2">
      <button onClick={() => onPlay(!playing)} aria-label={playing ? 'Pause' : 'Play'}
        className="h-9 w-9 rounded bg-ink-700 text-lg hover:bg-ink-600">{playing ? '❚❚' : '▶'}</button>
      <button onClick={() => { onPlay(false); onSeek(start); }} aria-label="Back to start"
        className="h-9 rounded bg-ink-800 px-2 text-xs text-ink-200 hover:bg-ink-700">|◀ start</button>
      <div className="w-44 font-mono text-sm leading-tight">
        <div>{fmtTime(now, timeZone)} <span className="text-ink-400">local</span></div>
        <div className="text-[11px] text-ink-400">{fmtTime(now, 'UTC')} UTC</div>
      </div>
      <div className="relative flex-1 pt-3">
        {marks.map((m, i) => (
          <span key={i} className={`absolute top-0 whitespace-nowrap text-[10px] ${m.label && i === 0 ? '' : '-translate-x-1/2'}`}
            style={{ left: `${(100 * (m.t - start)) / (end - start)}%`, color: m.colour }}>▼{m.label ? ` ${m.label}` : ''}</span>
        ))}
        <input type="range" className="w-full" min={start} max={end} step={600000} value={now}
          aria-label="Scenario time" onChange={(e) => onSeek(Number(e.target.value))} />
      </div>
      <label className="text-xs text-ink-400">
        speed{' '}
        <select value={speed} onChange={(e) => onSpeed(Number(e.target.value))}
          className="rounded bg-ink-800 px-1 py-1 text-ink-50">
          <option value={0.5}>30 min/s</option>
          <option value={1}>1 h/s</option>
          <option value={3}>3 h/s</option>
        </select>
      </label>
    </div>
  );
}
