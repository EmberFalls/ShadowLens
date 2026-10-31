namespace ShadowShield.Content {
  export interface ComposerAdapter {
    readonly siteId: "SANDBOX" | "CHATGPT" | "GEMINI" | "CLAUDE";
    readonly coverageMode: "SANDBOX_GUARDED" | "THIRD_PARTY_BEST_EFFORT";
    isSupportedTarget(target: EventTarget | null): boolean;
    isSendTarget(target: EventTarget | null): boolean;
    isSubmitTarget?(target: EventTarget | null): boolean;
    isComposerTarget(target: EventTarget | null): boolean;
    isUninspectableEditorShortcut?(event: KeyboardEvent): boolean;
    readDraft(): { text: string; revision: number } | null;
    writeDraft(text: string): boolean;
    release(attemptId: string): void;
    consumeReleaseGesture?(event: Event): boolean;
    resetPending?(): void;
    coverageLabel(): string;
    restoreDraft(text: string): boolean;
    onReceipt(listener: (attemptId: string) => void): () => void;
  }

  export class SandboxAdapter implements ComposerAdapter {
    private static readonly attemptIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    readonly siteId = "SANDBOX" as const;
    readonly coverageMode = "SANDBOX_GUARDED" as const;
    private revision = 0;
    private lastElement: HTMLTextAreaElement | null = null;
    private readonly released = new Map<string, number>();
    private readonly receiptListeners = new Set<(attemptId: string) => void>();
    private readonly observer: MutationObserver;

    constructor(private readonly root: Document) {
      root.addEventListener("input", this.onEdit, true);
      root.addEventListener("change", this.onEdit, true);
      this.observer = new MutationObserver(() => {
        const current = this.composer();
        if (current !== this.lastElement) { this.revision++; this.lastElement = current; }
      });
      this.observer.observe(root.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["id"] });
      root.addEventListener("shadowshield:receipt", this.onPageReceipt as EventListener, true);
    }

    isCompatible(): boolean { return Boolean(this.composer() && this.sendButton()); }

    isSendTarget(target: EventTarget | null): boolean { const button = this.sendButton(); return target instanceof Element && !!button && (button === target || button.contains(target)); }
    isComposerTarget(target: EventTarget | null): boolean { const composer = this.composer(); return target instanceof Element && !!composer && (composer === target || composer.contains(target)); }

    isSupportedTarget(target: EventTarget | null): boolean {
      if (!(target instanceof Element)) return false;
      const composer = this.composer();
      const button = this.sendButton();
      return Boolean(composer && (target === composer || composer.contains(target)) || button && (target === button || button.contains(target)));
    }

    readDraft(): { text: string; revision: number } | null {
      const composer = this.composer();
      if (!composer || !this.sendButton()) return null;
      if (composer !== this.lastElement) { this.lastElement = composer; this.revision++; }
      return { text: composer.value, revision: this.revision };
    }

    writeDraft(text: string): boolean { return this.setDraft(text); }
    restoreDraft(text: string): boolean { return this.setDraft(text); }

    release(attemptId: string): void {
      const now = Date.now();
      for (const [id, expiresAt] of this.released) if (expiresAt <= now) this.released.delete(id);
      if (!SandboxAdapter.attemptIdPattern.test(attemptId) || this.released.has(attemptId) || this.released.size >= 128) throw new Error("Release is not valid or was already used");
      const composer = this.composer();
      if (!composer) throw new Error("Sandbox composer disappeared");
      const expiresAt = now + 2_000;
      this.released.set(attemptId, expiresAt);
      // Use the owning document's window so embedded documents and unit-test
      // adapters do not accidentally depend on the top-level global window.
      this.root.defaultView?.setTimeout(() => {
        if (this.released.get(attemptId) === expiresAt) this.released.delete(attemptId);
      }, expiresAt - now);
      composer.dispatchEvent(new CustomEvent("shadowshield:submit-request", { bubbles: true, detail: { protocol: "v2", attemptId } }));
    }

    consumeReleaseGesture(_event: Event): boolean { return false; }
    resetPending(): void {}
    coverageLabel(): string { return "Guard active · local sandbox"; }

    onReceipt(listener: (attemptId: string) => void): () => void {
      this.receiptListeners.add(listener);
      return () => this.receiptListeners.delete(listener);
    }

    disconnect(): void {
      this.observer.disconnect();
      this.root.removeEventListener("input", this.onEdit, true);
      this.root.removeEventListener("change", this.onEdit, true);
      this.root.removeEventListener("shadowshield:receipt", this.onPageReceipt as EventListener, true);
      this.receiptListeners.clear();
    }

    private composer(): HTMLTextAreaElement | null { const element = this.root.querySelector("#shadow-composer"); return element instanceof HTMLTextAreaElement ? element : null; }
    private sendButton(): HTMLButtonElement | null { const element = this.root.querySelector("#shadow-send"); return element instanceof HTMLButtonElement ? element : null; }
    private readonly onEdit = (event: Event) => {
      if (event.target === this.composer()) this.revision++;
    };
    private readonly onPageReceipt = (event: CustomEvent<unknown>) => {
      const detail = event.detail as { protocol?: unknown; attemptId?: unknown; status?: unknown } | null;
      if (detail?.protocol !== "v2" || detail.status !== "ACCEPTED" || typeof detail.attemptId !== "string") return;
      const expiresAt = this.released.get(detail.attemptId);
      if (expiresAt === undefined || expiresAt <= Date.now()) return;
      this.released.delete(detail.attemptId);
      for (const listener of this.receiptListeners) listener(detail.attemptId);
    };
    private setDraft(text: string): boolean {
      const composer = this.composer();
      if (!composer) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (!setter) return false;
      setter.call(composer, text);
      composer.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      return composer.value === text && this.composer() === composer;
    }
  }
}

