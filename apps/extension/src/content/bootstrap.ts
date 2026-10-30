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
      if (!adapter.isCompatible()) {
        setCoverage("UNPROTECTED", "Sandbox composer unavailable · unprotected");
        return;
      }
      ShadowShield.Content.installGate(adapter);
      setCoverage("SANDBOX_GUARDED", "Guard active · local sandbox only");
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
