import type { DataClient, DomainSummaryV2 } from "../api/types.js";
import { ApprovalControl } from "../components/ApprovalControl.js";

export function Tools({ domains, client, onUpdated, timezone }: { domains: DomainSummaryV2[]; client: DataClient; onUpdated: (domain: DomainSummaryV2) => void; timezone: "UTC" | "Asia/Kolkata" }) {
  return <section className="panel"><h2>AI tool inventory</h2><p className="muted">Approval is an owner preference and does not enable or disable browser enforcement.</p>
    {!domains.length ? <p>No domains observed or configured.</p> : <div className="table-wrap"><table><thead><tr><th>Tool</th><th>Protection coverage</th><th>Visits</th><th>Sandbox guarded</th><th>Provider best-effort</th><th>Last observed</th><th>Approval</th></tr></thead><tbody>{domains.map((domain) => <tr key={domain.siteId}>
      <td>{domain.siteId}</td><td><span className={`pill ${domain.supportStatus.toLowerCase()}`}>{domain.supportStatus === "UNSUPPORTED" ? "UNPROTECTED · unsupported" : domain.supportStatus.replace("_", " ")}</span></td>
      <td>{domain.siteVisitsObserved}</td><td>{domain.guardedAttempts}</td><td>{domain.bestEffortAttempts}</td><td>{domain.lastVisitAt ? new Date(domain.lastVisitAt).toLocaleString("en-IN", { timeZone: timezone }) : "Not observed"}</td>
      <td><ApprovalControl domain={domain} client={client} onUpdated={onUpdated} /></td>
    </tr>)}</tbody></table></div>}
  </section>;
}
