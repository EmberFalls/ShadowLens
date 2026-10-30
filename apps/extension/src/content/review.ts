namespace ShadowShield.Content {
  export type ReviewResult = { approved: true; acknowledgeWarning: boolean } | { approved: false; acknowledgeWarning: false };
  export type ReviewHandle = { result: Promise<ReviewResult>; cancel: () => void };
  export function showReview(analysis: Analysis, approvedText: string): ReviewHandle {
    let resolveResult: (value: ReviewResult) => void = () => {};
    const result = new Promise<ReviewResult>((resolve) => { resolveResult = resolve; });
    const host = document.createElement("div");
    host.id = "shadowshield-review-host";
    let settled = false;
    const finish = (value: ReviewResult) => {
      if (settled) return;
      settled = true;
      host.remove();
      resolveResult(value);
    };
    {
      const shadow = host.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = `:host{all:initial} .scrim{position:fixed;inset:0;z-index:2147483647;background:#0a1511a8;display:grid;place-items:center;font:15px/1.5 system-ui,sans-serif;color:#17231d} .card{box-sizing:border-box;width:min(560px,calc(100vw - 32px));max-height:90vh;overflow:auto;background:#fff;border-radius:18px;padding:24px;box-shadow:0 24px 80px #0005} h2{margin:0 0 6px;font-size:21px} p{color:#596961;margin:6px 0 14px}.findings{max-height:150px;overflow:auto;background:#f4f7f4;border-radius:10px;padding:12px 14px}.finding{font-size:13px;padding:4px 0}.preview{white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow:auto;background:#f7f8f6;border:1px solid #e5eae6;border-radius:10px;padding:12px;font:13px/1.5 ui-monospace,monospace;color:#283a30}.buttons{display:flex;gap:9px;justify-content:flex-end;margin-top:18px}button{border:0;border-radius:9px;padding:10px 14px;font:600 14px system-ui;cursor:pointer}.cancel{background:#edf1ee;color:#314239}.approve{background:#174c3b;color:white}.ack{background:#a86b1e;color:#fff}.warn{color:#80541b;background:#fff6e8;border-radius:9px;padding:10px 12px;font-size:13px}`;
      const scrim = document.createElement("div"); scrim.className = "scrim";
      const card = document.createElement("section"); card.className = "card"; card.setAttribute("role", "dialog"); card.setAttribute("aria-modal", "true");
      const heading = document.createElement("h2"); heading.textContent = analysis.decision.action === "REDACT" ? "Review redacted message" : "Review sensitive message";
      const description = document.createElement("p"); description.textContent = "This review stays on your device. Matched text appears only in this local preview.";
      const previewLabel = document.createElement("p"); previewLabel.textContent = analysis.decision.action === "REDACT" ? "Approved text preview" : "Message to be sent";
      const preview = document.createElement("pre"); preview.className = "preview"; preview.textContent = approvedText;
      const list = document.createElement("div"); list.className = "findings";
      const counts = analysis.detection.categoryCounts as Record<string, number>;
      const labels = Object.entries(counts).filter(([, count]) => count > 0).map(([category, count]) => `${category.replaceAll("_", " ")} · ${count}`);
      for (const label of labels) { const item = document.createElement("div"); item.className = "finding"; item.textContent = label; list.append(item); }
      const warning = document.createElement("p"); warning.className = "warn"; warning.textContent = "This message still contains material covered by a warning rule."; warning.hidden = !analysis.decision.requiresWarnAcknowledgement;
      const buttons = document.createElement("div"); buttons.className = "buttons";
      let acknowledged = false;
      const cancel = document.createElement("button"); cancel.className = "cancel"; cancel.textContent = "Cancel";
      cancel.addEventListener("click", (event) => { if (!event.isTrusted) return; finish({ approved: false, acknowledgeWarning: false }); });
      if (analysis.decision.requiresWarnAcknowledgement) {
        const acknowledge = document.createElement("button"); acknowledge.className = "ack"; acknowledge.textContent = "Acknowledge warning";
        acknowledge.addEventListener("click", (event) => { if (!event.isTrusted) return; acknowledged = true; acknowledge.textContent = "Warning acknowledged"; acknowledge.disabled = true; });
        buttons.append(acknowledge);
      }
      const approve = document.createElement("button"); approve.className = "approve"; approve.textContent = analysis.decision.action === "REDACT" ? "Approve redacted message" : "Continue anyway";
      approve.addEventListener("click", (event) => {
        if (!event.isTrusted || analysis.decision.requiresWarnAcknowledgement && !acknowledged) return;
        finish({ approved: true, acknowledgeWarning: acknowledged });
      });
      buttons.append(cancel, approve); card.append(heading, description, list, warning, previewLabel, preview, buttons); scrim.append(card); shadow.append(style, scrim); document.documentElement.append(host);
      host.addEventListener("keydown", (event) => { if (event.isTrusted && event.key === "Escape") finish({ approved: false, acknowledgeWarning: false }); });
      cancel.focus();
    }
    return { result, cancel: () => finish({ approved: false, acknowledgeWarning: false }) };
  }
}
