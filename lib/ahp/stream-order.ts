export interface StreamEnvelope {
  type: string;
  epoch?: string;
  sequence?: number;
}

/** Each connection starts with a snapshot; retired epochs never regain authority. */
export class StreamOrder {
  private epoch: string | undefined;
  private sequence = 0;
  private readonly retired = new Set<string>();

  accept(event: StreamEnvelope): "accept" | "stale" | "resync" {
    const { epoch, sequence } = event;
    if (!epoch || typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1) return "resync";
    if (epoch !== this.epoch) {
      if (this.retired.has(epoch)) return "stale";
      if ((event.type !== "init" && event.type !== "error") || sequence !== 1) return "resync";
      if (this.epoch) this.retired.add(this.epoch);
      // Bound bookkeeping during a long-lived browser connection.
      if (this.retired.size > 64) return "resync";
      this.epoch = epoch;
      this.sequence = 0;
    }
    if (sequence <= this.sequence) return "stale";
    if (sequence !== this.sequence + 1) return "resync";
    this.sequence = sequence;
    return "accept";
  }
}
