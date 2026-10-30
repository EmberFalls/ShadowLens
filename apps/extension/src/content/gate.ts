namespace ShadowShield.Content {
  export interface GatePort {
    onSendGesture(event: Event, adapter: ComposerAdapter): void;
    cancelPending(reason: "USER_CANCELLED" | "EDITOR_CHANGED"): void;
    getCoverage(): "SANDBOX_GUARDED";
  }

  type Analysis = { detection: { inputLength: number; categoryCounts: Record<string, number>; aggregateTier: string; aggregateScore: number; findings: unknown[] }; decision: { action: "ALLOW" | "WARN" | "REDACT" | "BLOCK"; reasonCodes: string[]; replacementOperations: Array<{start:number;end:number;replacement:string}>; requiresWarnAcknowledgement: boolean; overrideAllowed: boolean } };

  export class ProtectedGate implements GatePort {
    private readonly machine = new GateStateMachine();
    private readonly oneShot = new Set<string>();
    private original: { text: string; revision: number } | null = null;
    private activeAdapter: ComposerAdapter | null = null;
    private pendingAction: Analysis["decision"]["action"] | null = null;
    private cancelReview: (() => void) | null = null;

    constructor(private readonly adapter: ComposerAdapter) {
      window.addEventListener("click", this.onClick, true);
      window.addEventListener("keydown", this.onKeyDown, true);
      window.addEventListener("input", this.onEdit, true);
      window.addEventListener("change", this.onEdit, true);
    }
    getCoverage(): "SANDBOX_GUARDED" { return "SANDBOX_GUARDED"; }
    destroy(): void {
      this.cancelReview?.();
      window.removeEventListener("click", this.onClick, true);
      window.removeEventListener("keydown", this.onKeyDown, true);
      window.removeEventListener("input", this.onEdit, true);
      window.removeEventListener("change", this.onEdit, true);
    }
    cancelPending(reason: "USER_CANCELLED" | "EDITOR_CHANGED"): void {
      if (this.machine.state === "READY") return;
      this.cancelReview?.();
      this.cancelReview = null;
      if (reason === "EDITOR_CHANGED") this.emitTerminal("FAILED_SAFE", null, [reason]);
      else this.emitTerminal("CANCELLED", this.pendingAction, [reason]);
      this.original = null; this.activeAdapter = null; this.pendingAction = null; this.machine.reset();
    }
    onSendGesture(event: Event, adapter: ComposerAdapter): void {
      if (!adapter.isSupportedTarget(event.target)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (!event.isTrusted || this.machine.state !== "READY") return;
      const snapshot = adapter.readDraft();
      if (!snapshot) { this.emitTerminal("FAILED_SAFE", null, ["ENGINE_FAILURE"]); return; }
      this.original = snapshot; this.activeAdapter = adapter;
      try { this.machine.move("ANALYZING"); } catch { this.machine.reset(); return; }
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; this.failSafe("SCANNER_TIMEOUT"); } }, 2500);
      chrome.runtime.sendMessage({ type: "ANALYZE_LOCAL", text: snapshot.text }, (response) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (chrome.runtime.lastError || !response?.ok || !response.analysis) { this.failSafe("ENGINE_FAILURE"); return; }
        void this.handleAnalysis(response.analysis as Analysis, adapter, snapshot);
      });
    }

    private readonly onClick = (event: Event) => this.onSendGesture(event, this.adapter);
    private readonly onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
      this.onSendGesture(event, this.adapter);
    };

    private async handleAnalysis(analysis: Analysis, adapter: ComposerAdapter, snapshot: {text:string;revision:number}): Promise<void> {
      const action = analysis.decision.action;
      if (action === "BLOCK") { this.emitTerminal("BLOCKED", "BLOCK", analysis.decision.reasonCodes); this.clearPending(); this.machine.reset(); return; }
      let approvedText = snapshot.text;
      if (action === "REDACT") {
        try { approvedText = analysis.decision.replacementOperations.slice().sort((a,b)=>b.start-a.start).reduce((text,op)=>text.slice(0,op.start)+op.replacement+text.slice(op.end),snapshot.text); }
        catch { this.failSafe("ENGINE_FAILURE"); return; }
      }
      if (action !== "ALLOW") {
        try { this.machine.move("REVIEWING"); } catch { this.failSafe("ENGINE_FAILURE"); return; }
        this.pendingAction = action;
        const reviewHandle = showReview(analysis, approvedText);
        this.cancelReview = reviewHandle.cancel;
        const review = await reviewHandle.result;
        this.cancelReview = null;
        if (!this.inState("REVIEWING")) return;
        if (!review.approved) { this.emitTerminal("CANCELLED", action, ["USER_CANCELLED"]); this.clearPending(); this.machine.reset(); return; }
        if (!this.unchanged(adapter, snapshot)) { this.failSafe("EDITOR_CHANGED"); return; }
        if (action === "REDACT") {
          this.machine.move("VERIFYING");
          const verified = await this.verify(snapshot.text, approvedText, analysis, review.acknowledgeWarning);
          if (!this.inState("VERIFYING")) return;
          if (verified !== "SAFE") { this.failSafe(verified === "TIMEOUT" ? "SCANNER_TIMEOUT" : "REDACTION_RESIDUAL"); return; }
        }
      } else if (!this.unchanged(adapter, snapshot)) { this.failSafe("EDITOR_CHANGED"); return; }
      this.release(adapter, approvedText, snapshot, action, analysis.decision.reasonCodes);
    }

    private unchanged(adapter: ComposerAdapter, snapshot: {text:string;revision:number}): boolean {
      const current = adapter.readDraft();
      return Boolean(current && current.text === snapshot.text && current.revision === snapshot.revision);
    }

    private inState(state: GateState): boolean { return this.machine.state === state; }

    private verify(originalText: string, approvedText: string, analysis: Analysis, warnAcknowledged: boolean): Promise<"SAFE" | "UNSAFE" | "TIMEOUT"> {
      return new Promise((resolve) => {
        let settled = false;
        const finish = (result: "SAFE" | "UNSAFE" | "TIMEOUT") => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
        const timer = setTimeout(() => finish("TIMEOUT"), 2500);
        chrome.runtime.sendMessage({ type: "VERIFY_REDACTION", originalText, approvedText, analysis, warnAcknowledged }, (response) => {
          if (chrome.runtime.lastError || response?.ok !== true) finish("UNSAFE");
          else finish(response.verification?.safe === true ? "SAFE" : "UNSAFE");
        });
      });
    }

    private release(adapter: ComposerAdapter, approvedText: string, snapshot: {text:string;revision:number}, action: string, reasons: string[]): void {
      try { this.machine.move("RELEASING"); } catch { this.failSafe("ENGINE_FAILURE"); return; }
      if (!this.unchanged(adapter, snapshot) || !adapter.writeDraft(approvedText)) { this.failSafe("RELEASE_WRITE_MISMATCH"); return; }
      const readback = adapter.readDraft();
      if (!readback || readback.text !== approvedText || this.oneShot.size > 10000) { this.failSafe("RELEASE_WRITE_MISMATCH"); return; }
      const attemptId = crypto.randomUUID(); this.oneShot.add(attemptId);
      let attested = false;
      const remove = adapter.onReceipt((receivedId) => { if (receivedId === attemptId) { attested = true; this.emitTerminal("PAGE_ATTESTED", action, [...reasons, "PAGE_ACK_RECEIVED"]); remove(); } });
      try { adapter.release(attemptId); }
      catch { remove(); this.failSafe("RELEASE_WRITE_MISMATCH"); return; }
      setTimeout(() => {
        if (!attested) this.emitTerminal("RELEASED_UNVERIFIED", action, reasons);
        this.clearPending(); this.machine.reset();
      }, 350);
    }

    private readonly onEdit = (event: Event) => {
      if ((this.machine.state === "REVIEWING" || this.machine.state === "VERIFYING") && this.activeAdapter?.isSupportedTarget(event.target)) this.cancelPending("EDITOR_CHANGED");
    };

    private clearPending(): void { this.original = null; this.activeAdapter = null; this.pendingAction = null; this.cancelReview = null; }
    private failSafe(reason: string): void { this.emitTerminal("FAILED_SAFE", null, [reason]); this.clearPending(); this.machine.reset(); }
    private emitTerminal(disposition: string, action: string | null, reasonCodes: string[]): void {
      // The service worker supplies pseudonymous device metadata and validates the bounded event.
      chrome.runtime.sendMessage({ type: "TERMINAL_DISPOSITION", disposition, action, reasonCodes: reasonCodes.slice(0, 8), score: null }, () => {});
    }
  }

  export function installGate(adapter: ComposerAdapter): void {
    new ProtectedGate(adapter);
  }
}
