namespace ShadowShield.Content {
  export type GateState = "READY" | "ANALYZING" | "REVIEWING" | "VERIFYING" | "RELEASING";
  export class GateStateMachine {
    private current: GateState = "READY";
    get state(): GateState { return this.current; }
    move(next: GateState): void {
      const allowed: Record<GateState, GateState[]> = {
        READY: ["ANALYZING"], ANALYZING: ["REVIEWING", "RELEASING", "READY"],
        REVIEWING: ["VERIFYING", "RELEASING", "READY"], VERIFYING: ["RELEASING", "READY"],
        RELEASING: ["READY"],
      };
      if (!allowed[this.current].includes(next)) throw new Error(`Invalid gate transition ${this.current} -> ${next}`);
      this.current = next;
    }
    reset(): void { this.current = "READY"; }
  }
}
