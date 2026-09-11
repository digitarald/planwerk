export class TurnSubmission {
  private state: "ready" | "started" | "cancelled" | "finished" = "ready";

  cancel(): void {
    if (this.state !== "finished") this.state = "cancelled";
  }

  tryStart(alreadyAborted: boolean): boolean {
    if (alreadyAborted || this.state !== "ready") {
      this.cancel();
      return false;
    }
    this.state = "started";
    return true;
  }

  finish(): void {
    if (this.state !== "cancelled") this.state = "finished";
  }

  get cancelled(): boolean {
    return this.state === "cancelled";
  }
}
