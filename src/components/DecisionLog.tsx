import { fmtTime } from '../data';
import type { Decision } from '../types';

const ACTION_LABEL: Record<Decision['action'], string> = {
  take: 'Take',
  confirm_urgency: 'Confirm urgency',
  dispatch: 'Dispatch',
  dispatch_no_access: 'Dispatch: no road access',
  reroute: 'Re-route',
  reroute_no_access: 'Re-route: no road access',
  dispatch_no_crew: 'Dispatch: no crew free',
  reassign: 'Reassign crew',
  unassigned: 'Crew taken away',
  settings: 'Setting changed',
};

interface Props {
  decisions: Decision[];
  scenarioId: string;
  timeZone: string;
  labelOf: (reportId: string) => string;
}

export function DecisionLog({ decisions, scenarioId, timeZone, labelOf }: Props) {
  const download = () => {
    const body = JSON.stringify({
      record: 'DecisionLog', schema_version: '0.1.0', scenario: scenarioId,
      exported_at: new Date().toISOString(), decisions,
    }, null, 2);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
    a.download = `decision-log_${scenarioId}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return (
    <div className="flex h-full flex-col text-sm">
      <div className="flex items-center justify-between border-b border-ink-700 p-3">
        <h2 className="text-xs font-bold uppercase tracking-wider text-ink-400">Decision log · {decisions.length}</h2>
        <button onClick={download} disabled={decisions.length === 0}
          className="rounded bg-ink-700 px-2 py-1 text-xs hover:bg-ink-600 disabled:opacity-40">Download JSON</button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {decisions.length === 0 && (
          <p className="p-3 text-ink-400">No decisions yet. Take a report, confirm its urgency, then dispatch.</p>
        )}
        {[...decisions].reverse().map((d) => (
          <div key={d.seq} className="border-b border-ink-800 px-3 py-2" data-decision={d.action}>
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-[11px] text-ink-400">#{d.seq}</span>
              <b>{ACTION_LABEL[d.action]}</b>
              <span className="ml-auto font-mono text-[11px] text-ink-400">{fmtTime(Date.parse(d.scenario_time), timeZone)}</span>
            </div>
            <div className="text-xs text-ink-200">{labelOf(d.report_id)}</div>
            <div className="text-xs">
              <span className="text-ink-400">{d.previous ?? '—'}</span> → <span className="font-semibold">{d.new ?? '—'}</span>
            </div>
            {d.note && <div className="text-xs text-ink-400">{d.note}</div>}
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-ink-400">
              <span>by {d.operator}</span>
              <span>clicked {new Date(d.decided_at).toLocaleTimeString('en-GB')}</span>
              {d.synthetic_report && <span className="synthetic-tag">SYNTHETIC REPORT</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
