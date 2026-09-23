/** Decides when a repeating indexer fault is worth another log line.
 *
 *  The loop ticks every two seconds, so logging each failing pass turned a nine
 *  hour provider outage into thousands of identical undated lines and hid both
 *  the start of the fault and its recovery. Report every transition, then
 *  summarise while the same fault persists. */
export class FaultLog {
  private previous: string | null = null;
  private since = 0;
  private repeats = 0;
  private lastReportAt = 0;
  constructor(private readonly repeatAfterMs = 300_000) {
    if (!Number.isInteger(repeatAfterMs) || repeatAfterMs < 1) throw new Error('Invalid fault repeat interval');
  }
  /** Returns the line to emit, or null to stay quiet. */
  observe(error: string | null, at: number): string | null {
    const stamp = new Date(at).toISOString();
    if (error === null) {
      if (this.previous === null) return null;
      const seconds = Math.round((at - this.since) / 1000);
      const recovered = `${stamp} indexer recovered after ${seconds}s and ${this.repeats + 1} failed passes; last fault: ${this.previous}`;
      this.previous = null; this.repeats = 0; this.lastReportAt = 0;
      return recovered;
    }
    if (error !== this.previous) {
      this.previous = error; this.since = at; this.repeats = 0; this.lastReportAt = at;
      return `${stamp} indexer paused: ${error}`;
    }
    this.repeats++;
    if (at - this.lastReportAt < this.repeatAfterMs) return null;
    this.lastReportAt = at;
    const minutes = Math.round((at - this.since) / 60000);
    return `${stamp} indexer still paused after ${minutes}m and ${this.repeats + 1} failed passes: ${error}`;
  }
}

/** Keeps a routine idle-connection fault from killing the process.
 *
 *  node-postgres re-emits idle client errors on the pool. With no listener Node
 *  treats that as an unhandled 'error' event and throws, so an administrator
 *  terminating an idle backend, or a database restart, crashed the operator and
 *  dumped the entire client object graph -- sockets, buffers, internal symbols
 *  -- into the error log. The pool already discards the broken client; the next
 *  indexing pass reconnects, and genuinely losing the database still fails
 *  closed through the normal health path.
 *
 *  The raw error is deliberately dropped rather than logged: database errors may
 *  carry connection details, matching the suppression used by the HTTP and
 *  indexing paths. */
export function guardPoolFaults(pool: { on(event: 'error', listener: (error: unknown) => void): unknown },
  report: (line: string) => void, now: () => number = Date.now): void {
  pool.on('error', () => {
    report(`${new Date(now()).toISOString()} database pool discarded a failed idle connection; indexing continues`);
  });
}
