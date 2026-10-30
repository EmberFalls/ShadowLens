import type { SummaryV2, TimeseriesV2, DomainSummaryV2, DeviceListV2 } from "../api/types.js";

function Metric({ label, value, note }: { label: string; value: number; note: string }) {
  return <article className="metric"><span>{label}</span><strong>{value.toLocaleString()}</strong><small>{note}</small></article>;
}

export function Overview({ summary, series, domains, devices }: { summary: SummaryV2 | null; series: TimeseriesV2 | null; domains: DomainSummaryV2[]; devices: DeviceListV2 | null }) {
  if (!summary) return <section className="panel"><h2>Overview</h2><p className="muted">No summary data available.</p></section>;
  const unsupported = domains.filter((domain) => domain.supportStatus === "UNSUPPORTED");
  return <>
    <section className="metrics">
      <Metric label="AI site visits observed" value={summary.siteVisitsObserved} note="Visits do not prove a prompt was sent." />
      <Metric label="Guarded attempts" value={summary.guardedAttempts} note="Sandbox guarded submissions only." />
      <Metric label="Redactions planned" value={summary.redactionsPlanned} note="Proposed actions; may not be released." />
      <Metric label="Redactions page-attested" value={summary.redactionsPageAttested} note="Page reported local acceptance; not proof of enforcement." />
    </section>
    <section className="grid-two">
      <article className="panel"><h2>Coverage</h2><p>{summary.coverageNote}</p>
        <p><strong>{summary.observedDevices}</strong> registered devices observed · <strong>{summary.freshDevices}</strong> recent · <strong>{summary.staleDevices}</strong> stale</p>
        <p className="muted">Unregistered devices are not monitored. Stale means not recently observed, not uninstalled or non-compliant.</p>
        {!!unsupported.length && <p className="warning">Unsupported domains observed: {unsupported.map((domain) => domain.siteId).join(", ")}. Activity may be visible, but submissions are unprotected.</p>}
      </article>
      <article className="panel"><h2>Trend · visits and guarded attempts</h2>
        {!series?.buckets.length ? <p className="muted">No trend data available.</p> : <div className="bars">{series.buckets.map((bucket) => <div className="bar-row" key={bucket.bucketDateLocal}><time>{bucket.bucketDateLocal.slice(5)}</time><span>Visits <b style={{ width: `${Math.min(100, bucket.siteVisitsObserved * 10)}%` }} /></span><span>Guarded <b className="green" style={{ width: `${Math.min(100, bucket.guardedAttempts * 10)}%` }} /></span><span>Redactions confirmed <b className="gold" style={{ width: `${Math.min(100, bucket.redactionsPageAttested * 20)}%` }} /></span></div>)}</div>}
        {series && <small className="muted">{series.timezone} local dates. Visits, guarded attempts, and page-attested redactions are separate measures.</small>}
      </article>
    </section>
    <section className="panel"><h2>Device last seen</h2><p className="muted">Server-ingested heartbeat/event timestamps for registered devices only.</p>
      {!devices?.items.length ? <p>No registered devices reported.</p> : <ul className="device-list">{devices.items.map((device) => <li key={device.deviceId}><code>{device.deviceId.slice(0, 8)}…</code><span>{device.observation === "STALE" ? "Stale · not recently observed" : device.observation === "NEVER_SEEN" ? "Never seen" : "Recently seen"}</span><time>{device.lastHeartbeatAt ?? "No heartbeat recorded"}</time></li>)}</ul>}
    </section>
  </>;
}
