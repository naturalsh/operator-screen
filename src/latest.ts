/**
 * Latest-request-wins: every computation gets an id; a result whose id is not the latest is dropped, and the
 * previous request's AbortSignal is aborted when a new one starts (fetches, Web Worker jobs). Used for anything
 * that can finish after the operator has already moved on (the slider moved, another forecast was asked for).
 *
 *   const job = requests.begin();
 *   const result = await compute(job.signal);
 *   if (!requests.isLatest(job.id)) return;   // stale: a newer request exists
 */
export class LatestRequest {
  private seq = 0;
  private controller: AbortController | null = null;

  /** Starts a request: aborts the previous one and returns this one's id and signal. */
  begin(): { id: number; signal: AbortSignal } {
    this.controller?.abort();
    this.controller = new AbortController();
    return { id: ++this.seq, signal: this.controller.signal };
  }

  /** True while no newer request has started. */
  isLatest(id: number): boolean {
    return id === this.seq;
  }

  /** Abandons the current request (e.g. the component goes away). */
  cancel(): void {
    this.controller?.abort();
    this.controller = null;
    this.seq++;
  }
}

/** A signal aborted by `signal` (if given) or after `ms`. AbortSignal.any / .timeout are missing on older phones. */
export function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(new Error('timeout')), ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); c.abort(signal.reason); }, { once: true });
  return c.signal;
}
