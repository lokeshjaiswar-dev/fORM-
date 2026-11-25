/**
 * At most `limit` upstream calls in flight per form in this process (contract section 3: REMOTE_BUSY). A form whose owner's
 * API is slow could otherwise hold every connection of the process, one 5 s call per keystroke of every respondent.
 */
export class FormConcurrency {
  private readonly inFlight = new Map<string, number>();

  private readonly limit: number;

  constructor(limit = 4) {
    this.limit = limit;
  }

  /** Runs `fn` if the form has a free slot; returns null (without running it) when it has none. */
  async run<T>(formId: string, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
    const n = this.inFlight.get(formId) ?? 0;
    if (n >= this.limit) return { ran: false };
    this.inFlight.set(formId, n + 1);
    try {
      return { ran: true, value: await fn() };
    } finally {
      const left = (this.inFlight.get(formId) ?? 1) - 1;
      if (left <= 0) this.inFlight.delete(formId);
      else this.inFlight.set(formId, left);
    }
  }
}
