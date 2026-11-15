import type { CallerReport } from '../types';

/** True when the caller did not speak English: the screen shows their words and an English translation. */
export const needsTranslation = (c: Pick<CallerReport, 'language'>) => c.language.toLowerCase() !== 'en';

/** The translation, or why there is none (a missing one is said, never filled with the original). */
export const translationOf = (c: Pick<CallerReport, 'summary_en'>) => c.summary_en?.trim() || null;

/**
 * What the caller said, in their own language, and under it "Translation: ..." in English when they spoke another
 * language. Used on the report card and in the decision log (the map popup has an HTML version, `quoteHtml`).
 */
export function ReportQuote({ c, className = '' }: { c: Pick<CallerReport, 'summary' | 'summary_en' | 'language'>; className?: string }) {
  if (!needsTranslation(c)) return <div data-report-quote className={`text-ink-200 ${className}`}>{c.summary}</div>;
  const en = translationOf(c);
  return (
    <div data-report-quote className={className}>
      <div className="italic text-ink-200" lang={c.language}>“{c.summary}”</div>
      <div data-translation className={en ? 'text-ink-100' : 'text-ink-400'}>
        <span className="text-ink-400">Translation{en ? '' : ' (EN)'}: </span>{en ?? 'not available yet'}
      </div>
    </div>
  );
}

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));

/** The same for the map popup (HTML string). */
export function quoteHtml(c: Pick<CallerReport, 'summary' | 'summary_en' | 'language'>): string {
  if (!needsTranslation(c)) return `<div data-report-quote>${esc(c.summary)}</div>`;
  const en = translationOf(c);
  return `<div data-report-quote><div style="font-style:italic" lang="${esc(c.language)}">“${esc(c.summary)}”</div>`
    + `<div data-translation><span style="opacity:.7">Translation: </span>${en ? esc(en) : '<span style="opacity:.7">not available yet</span>'}</div></div>`;
}
