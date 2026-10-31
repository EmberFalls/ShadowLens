namespace ShadowShield.Content {
  const SANDBOX_ORIGIN = "http://localhost:4173";

  export function start(): void {
    const isSandbox = window.location.origin === SANDBOX_ORIGIN;
    const providerId = isSandbox ? null : ShadowShield.Content.ProviderAdapter.siteForLocation(window.location);
    if (!isSandbox && !providerId) { setCoverage("UNSUPPORTED", "Unsupported AI site · observed only"); return; }
    setCoverage("UNPROTECTED", isSandbox ? "Sandbox guard initializing" : "AI site detected · guard initializing");
    const attach = () => {
      const adapter = providerId ? new ShadowShield.Content.ProviderAdapter(document, providerId) : new ShadowShield.Content.SandboxAdapter(document);
      const gate = ShadowShield.Content.installGate(adapter);
      let previous: boolean | undefined;
      const update = () => {
        const compatible = adapter.isCompatible();
        if (compatible === previous) return;
        previous = compatible;
        if (!compatible) gate.cancelPending("EDITOR_CHANGED");
        setCoverage(compatible ? adapter.coverageMode : "UNPROTECTED", compatible ? adapter.coverageLabel() : `${adapter.siteId} composer unavailable · unprotected`);
      };
      update();
      const observer = new MutationObserver(update);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["id", "data-testid", "data-placeholder", "aria-label", "aria-disabled", "aria-hidden", "disabled", "hidden", "style", "class", "role", "contenteditable", "type"],
      });
      // A page may be restored from the back/forward cache. Revoke approval, but
      // keep the adapter and gate listeners attached so resumed pages stay guarded.
      window.addEventListener("pagehide", () => gate.cancelPending("EDITOR_CHANGED"));
      window.addEventListener("pageshow", update);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", attach, { once: true });
    else attach();
  }
}

if (document.readyState === "loading") {
  ShadowShield.Content.start();
} else {
  ShadowShield.Content.start();
}
