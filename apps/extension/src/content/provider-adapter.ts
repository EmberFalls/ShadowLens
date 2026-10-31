namespace ShadowShield.Content {
  type Provider = "CHATGPT" | "GEMINI" | "CLAUDE";
  type ProviderConfig = { hosts: string[]; composer: string[]; send: string[]; label: string };
  const PROVIDER_OBSERVED_ATTRIBUTES = ["id", "data-testid", "data-placeholder", "aria-label", "aria-disabled", "aria-hidden", "disabled", "hidden", "style", "class", "role", "contenteditable", "type"];

  /** Provider editors may be rendered inside open web-component shadow roots. */
  function queryAcrossOpenShadowRoots(root: Document | ShadowRoot, selector: string): Element[] {
    const matches = Array.from(root.querySelectorAll(selector));
    for (const element of Array.from(root.querySelectorAll("*"))) {
      if (element.shadowRoot) matches.push(...queryAcrossOpenShadowRoots(element.shadowRoot, selector));
    }
    return matches;
  }

  const PROVIDERS: Record<Provider, ProviderConfig> = {
    CHATGPT: {
      hosts: ["chatgpt.com", "chat.openai.com"],
      composer: ["#prompt-textarea", "[data-testid='conversation-compose']", "main [contenteditable='true'][role='textbox']", "main [contenteditable='true']", "form [contenteditable='true'][data-placeholder]", "main textarea"],
      send: ["button[data-testid='send-button']", "button[data-testid*='composer-submit' i]", "button[aria-label*='Send' i]", "[role='button'][aria-label*='Send' i]"],
      label: "ChatGPT",
    },
    GEMINI: {
      hosts: ["gemini.google.com"],
      composer: [".text-input-field_textarea-wrapper textarea", ".text-input-field_textarea-wrapper [contenteditable='true']", ".text-input-field_textarea-wrapper [role='textbox']", "[contenteditable='true'][role='textbox']", "rich-textarea [contenteditable='true']", "main [contenteditable='true']", "textarea[aria-label*='prompt' i]", "textarea[placeholder*='prompt' i]"],
      send: ["button[aria-label*='Send' i]", "button[aria-label*='Submit' i]", "button[data-testid*='send' i]", "[role='button'][aria-label*='Send' i]"],
      label: "Gemini",
    },
    CLAUDE: {
      hosts: ["claude.ai"],
      composer: ["[contenteditable='true'][data-placeholder]", "[contenteditable='true'][role='textbox']", "fieldset [contenteditable='true']", "main [contenteditable='true']", "textarea"],
      send: ["button[aria-label*='Send' i]", "button[aria-label*='Submit' i]", "button[data-testid*='send' i]", "[role='button'][aria-label*='Send' i]"],
      label: "Claude",
    },
  };

  /** DOM adapter for provider web UIs. Selectors are intentionally scoped and compatibility is checked continuously. */
  export class ProviderAdapter implements ComposerAdapter {
    readonly coverageMode = "THIRD_PARTY_BEST_EFFORT" as const;
    readonly siteId: Provider;
    private revision = 0;
    private lastElement: HTMLElement | null = null;
    private readonly lastObservedText = new WeakMap<HTMLElement, string>();
    private selectedComposer: HTMLElement | null = null;
    private permit: { text: string; revision: number; expiresAt: number } | null = null;
    private nativePermit: { text: string; revision: number; expiresAt: number } | null = null;
    private noticeTimer: number | null = null;
    private readonly observer: MutationObserver;
    private readonly onEdit = (event: Event) => {
      if (!this.isComposerTarget(event.target) || !(event.target instanceof Element)) return;
      const composer = this.composerForTarget(event.target);
      if (!composer) return;
      const text = this.readText(composer);
      const previous = this.lastObservedText.get(composer);
      this.lastObservedText.set(composer, text);
      // Text controls emit `change` when they lose focus, even when no text was
      // changed. A blur during review must not cancel consent or invalidate the
      // exact-text permit; actual text changes still advance the revision.
      if (event.type === "change" && previous === text) return;
      this.revision++; this.permit = null; this.nativePermit = null; this.clearNotice();
    };
    private readonly onUnsupportedClick = (event: Event) => {
      const pathControl = event.composedPath().find((node): node is Element =>
        node instanceof Element && node.matches("button,[role='button'],input[type='file']"));
      const control = pathControl ?? (event.target instanceof Element
        ? event.target.closest("button,[role='button'],input[type='file']")
        : null);
      if (!control) return;
      const description = [control.getAttribute("aria-label"), control.getAttribute("title"), control.getAttribute("data-testid"), control.textContent].join(" ").toLowerCase();
      if (!control.matches("input[type='file']") && !/(attach|upload|file|image|photo|microphone|voice mode|record audio|dictat)/i.test(description)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.type === "change" && control instanceof HTMLInputElement && control.type === "file") control.value = "";
      this.showNotice("File attachments and provider voice controls are blocked because they are not inspected.");
    };
    private readonly onUnsupportedTransfer = (event: Event) => {
      const transfer = event instanceof ClipboardEvent ? event.clipboardData : event instanceof DragEvent ? event.dataTransfer : null;
      if (!transfer || transfer.files.length === 0) return;
      event.preventDefault(); event.stopImmediatePropagation();
      this.showNotice("File attachments are blocked because their contents are not inspected.");
    };

    constructor(private readonly root: Document, siteId: Provider) {
      this.siteId = siteId;
      root.addEventListener("input", this.onEdit, true);
      root.addEventListener("change", this.onEdit, true);
      root.addEventListener("click", this.onUnsupportedClick, true);
      root.addEventListener("change", this.onUnsupportedClick, true);
      root.addEventListener("paste", this.onUnsupportedTransfer, true);
      root.addEventListener("drop", this.onUnsupportedTransfer, true);
      root.addEventListener("dragover", this.onUnsupportedTransfer, true);
      this.observer = new MutationObserver(() => {
        const current = this.composer();
        if (current !== this.lastElement) { this.revision++; this.lastElement = current; this.permit = null; }
      });
      this.observer.observe(root.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: PROVIDER_OBSERVED_ATTRIBUTES });
    }

    static siteForLocation(location: Location): Provider | null {
      const hostname = location.hostname.toLowerCase();
      for (const [id, config] of Object.entries(PROVIDERS) as Array<[Provider, ProviderConfig]>) {
        if (config.hosts.includes(hostname)) return id;
      }
      return null;
    }

    isCompatible(): boolean { return this.composerCandidates().some((composer) => Boolean(this.sendButtonFor(composer, false))); }
    isSendTarget(target: EventTarget | null): boolean {
      if (!(target instanceof Element)) return false;
      const button = this.sendButtons().find((candidate) => candidate === target || candidate.contains(target));
      if (!button) return false;
      const composer = this.composerForTarget(button);
      if (!composer) {
        this.showNotice("ShadowLens can't inspect this prompt, so sending is blocked on this page.");
        return true;
      }
      if (this.sendButtonFor(composer, false) !== button) return false;
      this.selectedComposer = composer;
      return true;
    }
    isSubmitTarget(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLFormElement)) return false;
      const composers = this.composerCandidates().filter((candidate) => candidate.closest("form") === target);
      if (composers.length !== 1) {
        if (this.sendButtons().some((button) => target.contains(button))) {
          this.showNotice("ShadowLens can't inspect this prompt, so sending is blocked on this page.");
          return true;
        }
        return false;
      }
      this.selectedComposer = composers[0];
      return true;
    }
    isComposerTarget(target: EventTarget | null): boolean {
      if (!(target instanceof Element)) return false;
      const composer = this.composerCandidates().find((candidate) => candidate === target || candidate.contains(target));
      if (!composer) return false;
      this.selectedComposer = composer;
      return true;
    }
    isUninspectableEditorShortcut(event: KeyboardEvent): boolean {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return false;
      const path = event.composedPath();
      const editor = path.some((node) => node instanceof Element && node.matches(
        "textarea,input,[contenteditable='true'],[role='textbox'],.text-input-field_textarea-wrapper",
      ));
      if (!editor) return false;
      const knownGeminiEditor = path.some((node) => node instanceof Element && node.matches(".text-input-field_textarea-wrapper"));
      const sendInUnknownEditorRegion = this.sendButtons().some((button) =>
        path.some((node) => node instanceof HTMLElement
          && node.contains(button)
          && !this.composerCandidates().some((candidate) => node.contains(candidate))),
      );
      // A recognized composer elsewhere must not make an unrecognized active
      // editor's Enter shortcut slip through. Keep unrelated page inputs usable
      // when the adapter already has a compatible composer.
      if (this.isCompatible() && !knownGeminiEditor && !sendInUnknownEditorRegion) return false;
      this.showNotice("ShadowLens can't inspect this prompt, so sending is blocked on this page.");
      return true;
    }
    isSupportedTarget(target: EventTarget | null): boolean { return this.isSendTarget(target) || this.isComposerTarget(target); }
    readDraft(): { text: string; revision: number } | null {
      const composer = this.composer();
      if (!composer || !this.sendButtonFor(composer, false)) return null;
      if (composer !== this.lastElement) { this.lastElement = composer; this.revision++; }
      const text = this.readText(composer);
      if (!this.lastObservedText.has(composer)) this.lastObservedText.set(composer, text);
      return { text, revision: this.revision };
    }
    writeDraft(text: string): boolean {
      const composer = this.composer();
      if (!composer) return false;
      composer.focus();
      if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
        const prototype = composer instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (!setter) return false;
        setter.call(composer, text);
      } else {
        const selection = this.root.getSelection();
        if (!selection) return false;
        const range = this.root.createRange();
        range.selectNodeContents(composer);
        selection.removeAllRanges(); selection.addRange(range);
        if (!this.root.execCommand("insertText", false, text)) {
          composer.replaceChildren(this.root.createTextNode(text));
        }
      }
      composer.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
      this.revision++;
      return this.readText(composer) === text && this.composer() === composer;
    }
    restoreDraft(text: string): boolean { return this.writeDraft(text); }
    onReceipt(_listener: (attemptId: string) => void): () => void { return () => {}; }

    /** Approval arms only the next real Send gesture; the extension never fabricates a provider submit. */
    release(_attemptId: string): void {
      const draft = this.readDraft();
      if (!draft) throw new Error("Provider composer disappeared");
      this.permit = { text: draft.text, revision: draft.revision, expiresAt: Date.now() + 30_000 };
      this.showNotice("Reviewed locally. Click Send again to submit the approved text.", 30_000);
    }
    consumeReleaseGesture(event: Event): boolean {
      if (!event.isTrusted) return false;
      if (event.type === "submit" && this.isSubmitTarget(event.target)) {
        const continuation = this.nativePermit;
        this.nativePermit = null;
        const draft = this.readDraft();
        return Boolean(continuation && continuation.expiresAt >= Date.now() && draft
          && draft.text === continuation.text && draft.revision === continuation.revision);
      }
      if (!(event.type === "click" ? this.isSendTarget(event.target) : event.type === "keydown" && this.isComposerTarget(event.target))) return false;
      const permit = this.permit;
      this.permit = null;
      const draft = this.readDraft();
      if (!permit || permit.expiresAt < Date.now() || !draft || draft.text !== permit.text || draft.revision !== permit.revision) return false;
      this.nativePermit = { text: permit.text, revision: permit.revision, expiresAt: Date.now() + 2_000 };
      this.clearNotice();
      return true;
    }
    resetPending(): void {
      this.permit = null;
      this.nativePermit = null;
      this.clearNotice();
    }
    coverageLabel(): string {
      const config = PROVIDERS[this.siteId];
      return this.isCompatible()
        ? `${config.label} text guard active · best-effort; common file/voice controls blocked when recognized`
        : `${config.label} composer changed · protection unavailable`;
    }
    disconnect(): void {
      this.observer.disconnect();
      this.permit = null;
      this.nativePermit = null;
      this.root.removeEventListener("input", this.onEdit, true);
      this.root.removeEventListener("change", this.onEdit, true);
      this.root.removeEventListener("click", this.onUnsupportedClick, true);
      this.root.removeEventListener("change", this.onUnsupportedClick, true);
      this.root.removeEventListener("paste", this.onUnsupportedTransfer, true);
      this.root.removeEventListener("drop", this.onUnsupportedTransfer, true);
      this.root.removeEventListener("dragover", this.onUnsupportedTransfer, true);
      this.clearNotice();
    }
    private composer(): HTMLElement | null {
      const candidates = this.composerCandidates();
      if (this.selectedComposer && candidates.includes(this.selectedComposer)) return this.selectedComposer;
      const active = this.root.activeElement;
      const focused = candidates.find((candidate) => candidate === active || candidate.contains(active));
      if (focused) return focused;
      return candidates.length === 1 ? candidates[0] : null;
    }
    private composerCandidates(): HTMLElement[] {
      const result: HTMLElement[] = [];
      for (const selector of PROVIDERS[this.siteId].composer) {
        for (const candidate of queryAcrossOpenShadowRoots(this.root, selector)) {
          if (candidate instanceof HTMLElement
            && (candidate.isContentEditable || candidate instanceof HTMLTextAreaElement || candidate instanceof HTMLInputElement)
            && this.isVisible(candidate) && !result.includes(candidate)) result.push(candidate);
        }
      }
      return result;
    }
    private sendButtons(): HTMLElement[] {
      const result: HTMLElement[] = [];
      for (const selector of [...PROVIDERS[this.siteId].send, "form button[type='submit']", "form [role='button'][type='submit']"]) {
        for (const candidate of queryAcrossOpenShadowRoots(this.root, selector)) {
          if (candidate instanceof HTMLElement && this.isVisible(candidate) && !result.includes(candidate)) result.push(candidate);
        }
      }
      return result;
    }
    private sendButtonFor(composer: HTMLElement, requireEnabled = true): HTMLElement | null {
      const buttons = this.sendButtons().filter((button) => !requireEnabled || (!button.hasAttribute("disabled") && button.getAttribute("aria-disabled") !== "true"));
      const form = composer.closest("form");
      if (form) {
        const scoped = buttons.filter((button) => form.contains(button));
        if (scoped.length === 1) return scoped[0];
        if (scoped.length > 1) return null;
      }
      for (let scope: HTMLElement | null = composer.parentElement, depth = 0; scope && depth < 6; scope = scope.parentElement, depth++) {
        const composers = this.composerCandidates().filter((candidate) => scope.contains(candidate));
        if (composers.length !== 1 || composers[0] !== composer) continue;
        const scoped = buttons.filter((button) => scope.contains(button));
        if (scoped.length === 1) return scoped[0];
        if (scoped.length > 1) return null;
      }
      const composers = this.composerCandidates();
      return composers.length === 1 && buttons.length === 1 ? buttons[0] : null;
    }
    private composerForTarget(target: Element): HTMLElement | null {
      const candidates = this.composerCandidates();
      const form = target.closest("form");
      if (form) {
        const scoped = candidates.filter((candidate) => candidate.closest("form") === form);
        if (scoped.length === 1) return scoped[0];
        if (scoped.length > 1) return null;
      }
      for (let scope: HTMLElement | null = target instanceof HTMLElement ? target.parentElement : null, depth = 0; scope && depth < 6; scope = scope.parentElement, depth++) {
        const scoped = candidates.filter((candidate) => scope.contains(candidate));
        if (scoped.length === 1) return scoped[0];
      }
      const active = this.root.activeElement;
      const focused = candidates.find((candidate) => candidate === active || candidate.contains(active));
      if (focused) return focused;
      return candidates.length === 1 ? candidates[0] : null;
    }
    private isVisible(element: HTMLElement): boolean {
      if (!element.isConnected || element.closest("[hidden],[aria-hidden='true']")) return false;
      const style = this.root.defaultView?.getComputedStyle(element);
      return (!style || (style.display !== "none" && style.visibility !== "hidden")) && element.getClientRects().length > 0;
    }
    private readText(composer: HTMLElement): string {
      return composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement ? composer.value : (composer.innerText ?? composer.textContent ?? "");
    }
    private showNotice(message: string, duration = 7_000): void {
      this.clearNotice();
      const host = this.root.createElement("div");
      host.id = "shadowshield-provider-notice";
      const shadow = host.attachShadow({ mode: "closed" });
      const style = this.root.createElement("style");
      style.textContent = ":host{all:initial;position:fixed;pointer-events:none;z-index:2147483647;right:18px;top:18px;font:14px/1.4 system-ui,sans-serif}.notice{pointer-events:none;background:#173f32;color:white;padding:12px 16px;border-radius:10px;box-shadow:0 5px 24px #0004;max-width:360px}";
      const box = this.root.createElement("div"); box.className = "notice"; box.setAttribute("role", "status"); box.textContent = message;
      shadow.append(style, box); this.root.documentElement.append(host);
      this.noticeTimer = window.setTimeout(() => this.clearNotice(), duration);
    }
    private clearNotice(): void {
      if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer);
      this.noticeTimer = null;
      this.root.getElementById("shadowshield-provider-notice")?.remove();
    }
  }
}

