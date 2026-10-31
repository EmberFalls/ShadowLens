namespace ShadowShield.Options {
  const ownerOrigin = document.querySelector<HTMLInputElement>("#owner-origin")!;
  const saveOwnerOrigin = document.querySelector<HTMLButtonElement>("#save-owner-origin")!;
  const ownerOriginStatus = document.querySelector<HTMLElement>("#owner-origin-status")!;
  const defaultOrigin = "http://127.0.0.1:8787";

  function normalizeOrigin(raw: string): string | null {
    if (raw !== raw.trim() || raw.length > 2048) return null;
    try {
      const url = new URL(raw);
      const isLocal = url.origin === defaultOrigin;
      if ((!isLocal && url.protocol !== "https:") || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
      return url.origin;
    } catch { return null; }
  }

  chrome.runtime.sendMessage({ type: "GET_API_ORIGIN" }, response => {
    if (!chrome.runtime.lastError && typeof response?.origin === "string") ownerOrigin.value = response.origin;
    else { ownerOrigin.value = defaultOrigin; ownerOriginStatus.textContent = "Could not load the service setting."; }
  });
  saveOwnerOrigin.addEventListener("click", () => {
    if (saveOwnerOrigin.disabled) return;
    const origin = normalizeOrigin(ownerOrigin.value);
    if (!origin) { ownerOriginStatus.textContent = "Enter an HTTPS service origin, or http://127.0.0.1:8787 for the local demo."; return; }
    saveOwnerOrigin.disabled = true;
    const persist = () => chrome.runtime.sendMessage({ type: "SET_API_ORIGIN", origin }, response => {
      saveOwnerOrigin.disabled = false;
      if (chrome.runtime.lastError || response?.ok !== true) {
        ownerOriginStatus.textContent = response?.reason === "HOST_PERMISSION_REQUIRED" ? "Permission for this service was not granted." : "Could not save the service setting.";
        return;
      }
      ownerOrigin.value = origin;
      ownerOriginStatus.textContent = response.unchanged ? "Service setting unchanged." : "Service changed. Queued metadata and device credentials were cleared; reconnect with a credential issued by this service.";
      chrome.runtime.sendMessage({ type: "GET_CONNECTION_STATUS" }, connection => {
        if (!chrome.runtime.lastError && connection?.message) ownerOriginStatus.textContent += ` ${connection.message}`;
      });
    });
    if (origin === defaultOrigin) { persist(); return; }
    chrome.permissions.request({ origins: [`${origin}/*`] }, granted => {
      if (chrome.runtime.lastError || !granted) {
        saveOwnerOrigin.disabled = false;
        ownerOriginStatus.textContent = "Permission for this service was not granted.";
        return;
      }
      persist();
    });
  });

  const input = document.querySelector<HTMLInputElement>("#credential")!;
  const status = document.querySelector<HTMLElement>("#status")!;
  const connect = document.querySelector<HTMLButtonElement>("#connect")!;
  const deviceId = document.querySelector<HTMLInputElement>("#device-id")!;
  const policyKeyId = document.querySelector<HTMLInputElement>("#policy-key-id")!;
  const policyStatus = document.querySelector<HTMLElement>("#policy-status")!;
  const syncPolicyButton = document.querySelector<HTMLButtonElement>("#sync-policy")!;
  const rotatePolicyKeyButton = document.querySelector<HTMLButtonElement>("#rotate-policy-key")!;
  const observation = document.querySelector<HTMLInputElement>("#observe-domains")!;
  connect.addEventListener("click", () => {
    if (connect.disabled) return;
    const token = input.value;
    const id = deviceId.value.trim();
    if (!token.trim() || !id) { status.textContent = "Enter the provisioned device ID and bearer token."; return; }
    const keyId = policyKeyId.value.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(keyId)) { policyStatus.textContent = "Paste the 64-character policy key fingerprint from the owner dashboard."; return; }
    input.value = ""; deviceId.value = ""; connect.disabled = true;
    try {
      chrome.runtime.sendMessage({ type: "SET_DEVICE_CREDENTIAL", token, deviceId: id, policyKeyId: keyId }, (response) => {
        connect.disabled = false;
        status.textContent = !chrome.runtime.lastError && response?.ok ? "Credential saved for this browser session." : "Could not save credential for this session.";
        if (response?.ok) chrome.runtime.sendMessage({ type: "GET_CONNECTION_STATUS" }, connection => {
          if (!chrome.runtime.lastError && connection?.message) status.textContent = connection.message;
        });
      });
    } catch { connect.disabled = false; status.textContent = "Could not save credential for this session."; }
  });
  chrome.runtime.sendMessage({ type: "GET_CONNECTION_STATUS" }, (response) => {
    status.textContent = !chrome.runtime.lastError && response?.message || "Dashboard connection unavailable";
  });
  chrome.runtime.sendMessage({ type: "GET_POLICY_SYNC_STATUS" }, response => { policyStatus.textContent = !chrome.runtime.lastError && response?.message || "Signed policy status unavailable."; });
  syncPolicyButton.addEventListener("click", () => {
    syncPolicyButton.disabled = true;
    policyStatus.textContent = "Verifying the owner policy signature…";
    chrome.runtime.sendMessage({ type: "SYNC_POLICY_NOW" }, response => {
      syncPolicyButton.disabled = false;
      policyStatus.textContent = !chrome.runtime.lastError && response?.message || "Policy synchronization failed.";
    });
  });
  rotatePolicyKeyButton.addEventListener("click", () => {
    if (rotatePolicyKeyButton.disabled) return;
    const keyId = policyKeyId.value.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(keyId)) {
      policyStatus.textContent = "Paste the new 64-character fingerprint shown by the owner dashboard.";
      return;
    }
    rotatePolicyKeyButton.disabled = true;
    policyStatus.textContent = "Verifying the new key and signed policy. The existing key remains trusted until verification succeeds…";
    try {
      chrome.runtime.sendMessage({ type: "ROTATE_POLICY_KEY", keyId }, response => {
        rotatePolicyKeyButton.disabled = false;
        policyStatus.textContent = !chrome.runtime.lastError && typeof response?.message === "string"
          ? response.message
          : "Could not verify the new policy key. The previous trusted key remains active.";
      });
    } catch {
      rotatePolicyKeyButton.disabled = false;
      policyStatus.textContent = "Could not verify the new policy key. The previous trusted key remains active.";
    }
  });
  chrome.runtime.sendMessage({ type: "GET_DOMAIN_OBSERVATION" }, response => { observation.checked = !chrome.runtime.lastError && response?.enabled === true; });
  observation.addEventListener("change", () => {
    const requestedState = observation.checked;
    observation.disabled = true;
    try {
      chrome.runtime.sendMessage({ type: "SET_DOMAIN_OBSERVATION", enabled: requestedState }, response => {
        observation.disabled = false;
        if (chrome.runtime.lastError || response?.ok !== true) observation.checked = !requestedState;
      });
    } catch { observation.disabled = false; observation.checked = !requestedState; }
  });

  const customTerms = document.querySelector<HTMLTextAreaElement>("#custom-terms");
  const saveTerms = document.querySelector<HTMLButtonElement>("#save-custom-terms");
  const termsStatus = document.querySelector<HTMLElement>("#custom-terms-status");
  if (customTerms && saveTerms && termsStatus) {
    saveTerms.disabled = true;
    chrome.runtime.sendMessage({ type: "GET_CUSTOM_TERMS" }, response => {
      if (chrome.runtime.lastError || !Array.isArray(response?.terms)) {
        termsStatus.textContent = "Could not load local terms.";
        saveTerms.disabled = false;
        return;
      }
      customTerms.value = response.terms.join("\n");
      termsStatus.textContent = `Saved locally · policy revision ${response.revision ?? 1}`;
      saveTerms.disabled = false;
    });
    saveTerms.addEventListener("click", () => {
      if (saveTerms.disabled) return;
      const terms = customTerms.value.split(/\r?\n/u).map(term => term.trim()).filter(Boolean);
      saveTerms.disabled = true;
      try {
        chrome.runtime.sendMessage({ type: "SET_CUSTOM_TERMS", terms }, response => {
          saveTerms.disabled = false;
          if (chrome.runtime.lastError || response?.ok !== true) {
            termsStatus.textContent = "Could not save terms. Use 3–100 characters per line, no duplicates, up to 100 terms.";
            return;
          }
          customTerms.value = response.terms.join("\n");
          termsStatus.textContent = `Saved locally · policy revision ${response.revision}`;
        });
      } catch { saveTerms.disabled = false; termsStatus.textContent = "Could not save terms locally."; }
    });
  }

  const simulate = document.querySelector<HTMLButtonElement>("#simulate-policy");
  const simulationResult = document.querySelector<HTMLElement>("#simulation-result");
  if (simulate && simulationResult) simulate.addEventListener("click", () => {
    simulate.disabled = true;
    simulationResult.textContent = "Running local synthetic checks…";
    try {
      chrome.runtime.sendMessage({ type: "SIMULATE_POLICY" }, response => {
        simulate.disabled = false;
        if (chrome.runtime.lastError || response?.ok !== true) {
          simulationResult.textContent = "Local simulation unavailable.";
          return;
        }
        const actions = response.actions as Record<string, number>;
        simulationResult.textContent = `${response.sampleCount} synthetic samples · allow ${actions.ALLOW ?? 0} · warn ${actions.WARN ?? 0} · redact ${actions.REDACT ?? 0} · block ${actions.BLOCK ?? 0} · policy revision ${response.revision}`;
      });
    } catch { simulate.disabled = false; simulationResult.textContent = "Local simulation unavailable."; }
  });
}
