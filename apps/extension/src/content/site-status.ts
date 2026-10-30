namespace ShadowShield.Content {
  export function setCoverage(mode: ShadowShield.Messages.CoverageStatus["mode"], label: string): void {
    const updateDocument = () => {
      const root = document.documentElement;
      if (!root) return false;
      root.dataset.shadowshieldCoverage = mode;
      root.dataset.shadowshieldCoverageLabel = label;
      return true;
    };
    if (!updateDocument()) document.addEventListener("DOMContentLoaded", updateDocument, { once: true });
    chrome.runtime.sendMessage({ type: "COVERAGE_UPDATE", coverage: { mode, label } }, () => {});
  }
}
