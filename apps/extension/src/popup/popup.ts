namespace ShadowShield.Popup {
  type StatusResponse = { coverage?: ShadowShield.Messages.CoverageStatus; connection?: ShadowShield.Messages.ConnectionStatus };
  chrome.runtime.sendMessage({ type: "GET_COVERAGE" }, (value) => {
    const response = value as StatusResponse | undefined;
    document.querySelector<HTMLElement>("#coverage")!.textContent = response?.coverage?.label ?? "No protected tab detected";
    document.querySelector<HTMLElement>("#connection")!.textContent = response?.connection?.message ?? "Dashboard connection unavailable";
    document.querySelector<HTMLElement>("#indicator")!.classList.toggle("active", response?.coverage?.mode === "SANDBOX_GUARDED");
  });
  document.querySelector<HTMLButtonElement>("#open-options")!.addEventListener("click", () => chrome.runtime.openOptionsPage());
}
