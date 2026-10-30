import type { EventPageV2 } from "../api/types.js";

export function Events({ page, timezone }: { page: EventPageV2 | null; timezone: "UTC" | "Asia/Kolkata" }) {
  if (!page?.items.length) return <section className="panel"><h2>Recent events</h2><p className="muted">No events available.</p></section>;
  return <section className="panel"><h2>Recent events</h2><p className="muted">Metadata only. Raw prompts are never displayed.</p><div className="table-wrap"><table><thead><tr><th>Observed</th><th>Device</th><th>Event</th><th>Tool</th><th>Outcome</th><th>Risk</th></tr></thead><tbody>{page.items.map((event) => <tr key={event.eventId}>
    <td>{new Date(event.clientObservedAt).toLocaleString("en-IN", { timeZone: timezone, timeZoneName: "short" })}</td><td><code>{event.deviceId.slice(0, 8)}…</code></td><td>{event.kind === "SITE_VISIT" ? "Visit observed" : event.kind === "SUBMISSION" ? "Guarded attempt" : "Heartbeat"}</td><td>{"siteId" in event ? event.siteId : "—"}</td>
    <td>{event.kind === "SUBMISSION" ? event.disposition.replaceAll("_", " ") : event.kind === "SITE_VISIT" ? event.supportStatus.replaceAll("_", " ") : "Device seen"}</td><td>{event.kind === "SUBMISSION" ? event.aggregateTier === "NOT_EVALUATED" ? "NOT_EVALUATED" : event.aggregateTier : "—"}</td>
  </tr>)}</tbody></table></div></section>;
}
