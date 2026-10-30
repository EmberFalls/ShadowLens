import { useState } from "react";
import type { ApprovalStatus, DomainSummaryV2, DataClient } from "../api/types.js";

export function ApprovalControl({ domain, client, onUpdated }: { domain: DomainSummaryV2; client: DataClient; onUpdated: (value: DomainSummaryV2) => void }) {
  const [status, setStatus] = useState<"idle" | "pending" | "success" | "failure">("idle");
  const [choice, setChoice] = useState<ApprovalStatus>(domain.approvalStatus);
  async function save() {
    setStatus("pending");
    try { onUpdated(await client.setApproval(domain.siteId, choice)); setStatus("success"); }
    catch { setStatus("failure"); }
  }
  return <div className="approval">
    <label>Approval <select value={choice} onChange={(event) => setChoice(event.target.value as ApprovalStatus)}>
      <option>UNREVIEWED</option><option>APPROVED</option><option>UNAPPROVED</option>
    </select></label>
    <button disabled={status === "pending" || choice === domain.approvalStatus} onClick={save}>{status === "pending" ? "Saving…" : "Save"}</button>
    <span role="status">{status === "pending" ? "Pending" : status === "success" ? "Saved · informational only" : status === "failure" ? "Could not save" : ""}</span>
  </div>;
}
