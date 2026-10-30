namespace ShadowShield.Content {
  const SANDBOX_ORIGIN = "http://localhost:4173";

  export function start(): void {
    if (window.location.origin !== SANDBOX_ORIGIN) {
      setCoverage("UNSUPPORTED", "Observed only · unsupported origin");
      return;
    }
    setCoverage("UNPROTECTED", "Sandbox detected · guard initializing");
    const attach = () => {
      const adapter = new ShadowShield.Content.SandboxAdapter(document);
      const gate = ShadowShield.Content.installGate(adapter);
      let previous: boolean | undefined;
      const update = () => {
        const compatible = adapter.isCompatible();
        if (compatible === previous) return;
        previous = compatible;
        if (!compatible) gate.cancelPending("EDITOR_CHANGED");
        setCoverage(compatible ? "SANDBOX_GUARDED" : "UNPROTECTED", compatible ? "Guard active · local sandbox only" : "Sandbox composer unavailable · unprotected");
      };
      update();
      const observer = new MutationObserver(update);
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["id"] });
      // Keep listeners alive for back/forward-cache restores. The browser disposes
      // them with the document; pending consent must not survive navigation.
      window.addEventListener("pagehide", () => gate.cancelPending("EDITOR_CHANGED"));
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
