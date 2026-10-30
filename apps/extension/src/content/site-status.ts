namespace ShadowShield.Content {
  export function setCoverage(mode: ShadowShield.Messages.CoverageStatus["mode"], label: string): void {
    document.documentElement.dataset.shadowshieldCoverage = mode;
    document.documentElement.dataset.shadowshieldCoverageLabel = label;
    chrome.runtime.sendMessage({ type: "COVERAGE_UPDATE", coverage: { mode, label } }, () => {});
  }
}
