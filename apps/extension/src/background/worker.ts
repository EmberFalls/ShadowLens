import { analyze, verifyRedaction } from "../../../../packages/engine/src/index.js";
import { DEFAULT_POLICY } from "../../../../packages/engine/src/default-policy.js";

type Coverage = { mode: "SANDBOX_GUARDED" | "UNPROTECTED" | "UNSUPPORTED"; label: string };
const coverageByTab = new Map<number, Coverage>();

void chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  if (message.type === "COVERAGE_UPDATE") {
    if (sender.tab?.id !== undefined && sender.url?.startsWith("http://localhost:4173/") && isCoverage(message.coverage)) {
      coverageByTab.set(sender.tab.id, message.coverage);
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "GET_COVERAGE") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      sendResponse({
        coverage: tabId === undefined ? undefined : coverageByTab.get(tabId) ?? { mode: "UNPROTECTED", label: "No protected tab detected" },
        connection: { connected: false, reconnectRequired: false, message: "Local API connection is not configured" },
      });
    });
    return true;
  }

  if (message.type === "GET_CONNECTION_STATUS") {
    sendResponse({ connected: false, reconnectRequired: false, message: "Local API connection is not configured" });
    return false;
  }

  if (message.type === "SET_DEVICE_CREDENTIAL") {
    const token = message.token;
    if (typeof token !== "string" || token.length < 16 || token.length > 512 || token.trim() !== token) {
      sendResponse({ ok: false });
      return false;
    }
    void chrome.storage.session.set({ deviceCredential: token })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === "ANALYZE_LOCAL") {
    if (typeof message.text !== "string") { sendResponse({ ok: false }); return false; }
    try {
      const analysis = analyze({ text: message.text, policy: DEFAULT_POLICY });
      sendResponse({ ok: true, analysis });
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "ENGINE_FAILURE";
      sendResponse({ ok: false, error: code });
    }
    return false;
  }

  if (message.type === "VERIFY_REDACTION") {
    try {
      if (typeof message.originalText !== "string" || typeof message.approvedText !== "string" || !message.analysis) throw new Error("invalid");
      const verification = verifyRedaction({
        originalText: message.originalText,
        approvedText: message.approvedText,
        analysis: message.analysis,
        policy: DEFAULT_POLICY,
        warnAcknowledged: message.warnAcknowledged === true,
      });
      sendResponse({ ok: true, verification });
    } catch {
      sendResponse({ ok: false });
    }
    return false;
  }

  // Queue and terminal event composition are added by SH-009.
  if (message.type === "ENQUEUE_EVENT" || message.type === "TERMINAL_DISPOSITION") {
    sendResponse({ ok: false, queued: false });
    return false;
  }
  return false;
});

function isCoverage(value: unknown): value is Coverage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Coverage;
  return ["SANDBOX_GUARDED", "UNPROTECTED", "UNSUPPORTED"].includes(candidate.mode) && typeof candidate.label === "string" && candidate.label.length <= 100;
}
