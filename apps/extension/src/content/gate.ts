namespace ShadowShield.Content {
  export interface GatePort {
    onSendGesture(event: Event, adapter: ComposerAdapter): void;
    cancelPending(reason: "USER_CANCELLED" | "EDITOR_CHANGED"): void;
    getCoverage(): "SANDBOX_GUARDED";
  }

  export type Analysis = { detection: { inputLength: number; engineVersion: string; scanCompleteness: string; categoryCounts: Record<string, number>; aggregateTier: string; aggregateScore: number; findings: unknown[] }; decision: { action: "ALLOW" | "WARN" | "REDACT" | "BLOCK"; policyRevision: number; reasonCodes: string[]; replacementOperations: Array<{start:number;end:number;replacement:string}>; requiresWarnAcknowledgement: boolean; overrideAllowed: boolean } };

  export class ProtectedGate implements GatePort {
    private readonly machine = new GateStateMachine();
    private readonly oneShot = new Set<string>();
    private original: { text: string; revision: number } | null = null;
    private activeAdapter: ComposerAdapter | null = null;
    private pendingAction: Analysis["decision"]["action"] | null = null;
    private cancelReview: (() => void) | null = null;
    private analysis: Analysis | null = null;
    private generation = 0;
    private destroyed = false;

    constructor(private readonly adapter: ComposerAdapter) {
      window.addEventListener("click", this.onClick, true);
      window.addEventListener("keydown", this.onKeyDown, true);
      window.addEventListener("input", this.onEdit, true);
      window.addEventListener("change", this.onEdit, true);
    }
    getCoverage(): "SANDBOX_GUARDED" { return "SANDBOX_GUARDED"; }
    destroy(): void {
      this.destroyed = true;
      this.cancelReview?.(); this.clearPending(); this.machine.reset();
      window.removeEventListener("click", this.onClick, true);
      window.removeEventListener("keydown", this.onKeyDown, true);
      window.removeEventListener("input", this.onEdit, true);
      window.removeEventListener("change", this.onEdit, true);
    }
    cancelPending(reason: "USER_CANCELLED" | "EDITOR_CHANGED"): void {
      if (this.machine.state === "READY" || this.machine.state === "RELEASING") return;
      this.cancelReview?.();
      this.cancelReview = null;
      if (reason === "EDITOR_CHANGED" || !this.analysis) this.emitTerminal("FAILED_SAFE", null, [reason]);
      else this.emitTerminal("CANCELLED", this.pendingAction, [reason]);
      this.clearPending(); this.machine.reset();
    }
    onSendGesture(event: Event, adapter: ComposerAdapter): void {
      if (!(event.type === "click" ? adapter.isSendTarget(event.target) : adapter.isComposerTarget(event.target))) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (!event.isTrusted || this.destroyed || this.machine.state !== "READY") return;
      const snapshot = adapter.readDraft();
      if (!snapshot) { this.emitTerminal("FAILED_SAFE", null, ["ENGINE_FAILURE"]); return; }
      this.original = Object.freeze(snapshot); this.activeAdapter = adapter;
      const generation = ++this.generation;
      try { this.machine.move("ANALYZING"); } catch { this.machine.reset(); return; }
      let settled = false;
      const timer = setTimeout(() => { if (!settled && generation === this.generation) { settled = true; this.failSafe("SCANNER_TIMEOUT"); } }, 2500);
      try { chrome.runtime.sendMessage({ type: "ANALYZE_LOCAL", text: snapshot.text }, (response) => {
        if (settled || generation !== this.generation) return;
        settled = true; clearTimeout(timer);
        if (chrome.runtime.lastError || !response?.ok || !response.analysis) { this.failSafe(["INPUT_TOO_LONG", "INVALID_POLICY", "SCANNER_TIMEOUT"].includes(response?.error) ? response.error : "ENGINE_FAILURE"); return; }
        void this.handleAnalysis(response.analysis as Analysis, adapter, snapshot).catch(() => { if (generation === this.generation) this.failSafe("ENGINE_FAILURE"); });
      }); } catch { clearTimeout(timer); this.failSafe("ENGINE_FAILURE"); }
    }

    private readonly onClick = (event: Event) => this.onSendGesture(event, this.adapter);
    private readonly onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
      this.onSendGesture(event, this.adapter);
    };

    private async handleAnalysis(analysis: Analysis, adapter: ComposerAdapter, snapshot: {text:string;revision:number}): Promise<void> {
      if (!analysis?.decision || !analysis?.detection || analysis.detection.scanCompleteness !== "FULL" || analysis.detection.inputLength !== snapshot.text.length || !["ALLOW", "WARN", "REDACT", "BLOCK"].includes(analysis.decision.action)) throw new Error("Invalid analysis");
      this.analysis = analysis;
      if (!this.unchanged(adapter, snapshot)) { this.failSafe("EDITOR_CHANGED"); return; }
      const action = analysis.decision.action;
      if (action === "BLOCK") { this.emitTerminal("BLOCKED", "BLOCK", analysis.decision.reasonCodes); this.clearPending(); this.machine.reset(); return; }
      let approvedText = snapshot.text;
      if (action === "REDACT") {
        try { approvedText = analysis.decision.replacementOperations.slice().sort((a,b)=>b.start-a.start).reduce((text,op)=>text.slice(0,op.start)+op.replacement+text.slice(op.end),snapshot.text); }
        catch { this.failSafe("ENGINE_FAILURE"); return; }
      }
      if (action !== "ALLOW") {
        if (action === "WARN" && (!analysis.decision.requiresWarnAcknowledgement || !analysis.decision.overrideAllowed)) throw new Error("Invalid warning consent");
        try { this.machine.move("REVIEWING"); } catch { this.failSafe("ENGINE_FAILURE"); return; }
        this.pendingAction = action;
        const reviewHandle = showReview(analysis, approvedText);
        this.cancelReview = reviewHandle.cancel;
        const review = await reviewHandle.result;
        if (this.original !== snapshot || !this.inState("REVIEWING")) return;
        this.cancelReview = null;
        if (!review.approved) { this.emitTerminal("CANCELLED", action, ["USER_CANCELLED"]); this.clearPending(); this.machine.reset(); return; }
        if (analysis.decision.requiresWarnAcknowledgement && !review.acknowledgeWarning) throw new Error("Missing warning consent");
        if (!this.unchanged(adapter, snapshot)) { this.failSafe("EDITOR_CHANGED"); return; }
        if (action === "REDACT") {
          this.machine.move("VERIFYING");
          const verified = await this.verify(snapshot.text, approvedText, analysis, review.acknowledgeWarning);
          if (this.original !== snapshot || !this.inState("VERIFYING")) return;
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
      let closed = false;
      const remove = adapter.onReceipt((receivedId) => { if (!closed && receivedId === attemptId && this.original === snapshot) { attested = true; closed = true; this.emitTerminal("PAGE_ATTESTED", action, [...reasons, "PAGE_ACK_RECEIVED"]); remove(); } });
      try { adapter.release(attemptId); }
      catch { remove(); this.failSafe("RELEASE_WRITE_MISMATCH"); return; }
      setTimeout(() => {
        closed = true; remove();
        if (this.original !== snapshot) return;
        if (!attested) this.emitTerminal("RELEASED_UNVERIFIED", action, [...reasons, "PAGE_ACK_TIMEOUT"]);
        this.clearPending(); this.machine.reset();
      }, 350);
    }

    private readonly onEdit = (event: Event) => {
      if (this.machine.state !== "READY" && this.machine.state !== "RELEASING" && this.activeAdapter?.isComposerTarget(event.target)) this.cancelPending("EDITOR_CHANGED");
    };

    private clearPending(): void { this.generation++; this.cancelReview?.(); this.original = null; this.activeAdapter = null; this.pendingAction = null; this.cancelReview = null; this.analysis = null; }
    private failSafe(reason: string): void { this.emitTerminal("FAILED_SAFE", null, [reason]); this.clearPending(); this.machine.reset(); }
    private emitTerminal(disposition: string, action: string | null, reasonCodes: string[]): void {
      const failed = disposition === "FAILED_SAFE";
      const analysis = this.analysis;
      const length = this.original?.text.length ?? 0;
      const tier = analysis?.detection.aggregateTier ?? "NONE";
      const event = { contractVersion: "v2", eventId: crypto.randomUUID(), clientObservedAt: new Date().toISOString(), kind: "SUBMISSION", siteId: "SANDBOX", coverageMode: "SANDBOX_GUARDED", disposition,
        decisionAction: failed ? null : action, aggregateTier: failed ? "NOT_EVALUATED" : tier, scoreBand: failed ? "NOT_EVALUATED" : tier === "NONE" ? "ZERO" : tier,
        categoryCounts: failed ? {} : analysis?.detection.categoryCounts ?? {}, policyRevision: analysis?.decision.policyRevision ?? 1, engineVersion: analysis?.detection.engineVersion ?? "0.1.0",
        lengthBand: length === 0 ? "EMPTY" : length < 100 ? "1_99" : length < 1000 ? "100_999" : "1000_PLUS", reasonCodes: [...new Set(reasonCodes)].slice(-8) };
      // The worker adds its device ID and validates before persistence. Prompt text stays local.
      try { chrome.runtime.sendMessage({ type: "ENQUEUE_EVENT", event }, () => { void chrome.runtime.lastError; }); } catch { /* Local protection works offline. */ }
    }
  }

  export function installGate(adapter: ComposerAdapter): ProtectedGate {
    return new ProtectedGate(adapter);
  }
}
