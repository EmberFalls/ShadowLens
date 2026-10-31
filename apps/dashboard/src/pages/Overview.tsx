import { useState } from "react";
import type { DataClient, SummaryV2, TimeseriesV2, DomainSummaryV2, DeviceListV2 } from "../api/types.js";
import type { NewDeviceCredential } from "../api/types.js";

function Metric({ label, value, note }: { label: string; value: number; note: string }) {
  return <article className="metric"><span>{label}</span><strong>{value.toLocaleString()}</strong><small>{note}</small></article>;
}

export function Overview({ summary, series, domains, devices, client, onDevicesUpdated }: { summary: SummaryV2 | null; series: TimeseriesV2 | null; domains: DomainSummaryV2[]; devices: DeviceListV2 | null; client: DataClient; onDevicesUpdated: (devices: DeviceListV2) => void }) {
  const [revokingDeviceId, setRevokingDeviceId] = useState<string | null>(null);
  const [deviceActionError, setDeviceActionError] = useState<string | null>(null);
  const [deviceLabel, setDeviceLabel] = useState("");
  const [enrollingDevice, setEnrollingDevice] = useState(false);
  const [issuedCredential, setIssuedCredential] = useState<NewDeviceCredential | null>(null);
  const revokeDevice = async (deviceId: string) => {
    setDeviceActionError(null); setRevokingDeviceId(deviceId);
    try { onDevicesUpdated(await client.revokeDevice(deviceId)); }
    catch { setDeviceActionError("Device revocation failed. Refresh the dashboard and try again."); }
    finally { setRevokingDeviceId(null); }
  };
  const enrollDevice = async () => {
    setDeviceActionError(null); setIssuedCredential(null); setEnrollingDevice(true);
    try {
      const issued = await client.enrollDevice(deviceLabel);
      onDevicesUpdated(await client.getDevices());
      setIssuedCredential(issued); setDeviceLabel("");
    } catch { setDeviceActionError("Device enrollment failed. Check the label and owner connection, then try again."); }
    finally { setEnrollingDevice(false); }
  };
  if (!summary) return <section className="panel"><h2>Overview</h2><p className="muted">No summary data available.</p></section>;
  const unsupported = domains.filter((domain) => domain.supportStatus === "UNSUPPORTED");
  const bestEffort = domains.filter((domain) => domain.supportStatus === "BEST_EFFORT");
  return <>
    <section className="metrics">
      <Metric label="AI site visits observed" value={summary.siteVisitsObserved} note="Visits do not prove a prompt was sent." />
      <Metric label="Sandbox guarded attempts" value={summary.guardedAttempts} note="Receiver-verified local sandbox path." />
      <Metric label="Provider best-effort attempts" value={summary.bestEffortAttempts} note="Text composer path; coverage is site-dependent." />
      <Metric label="Redactions planned" value={summary.redactionsPlanned} note="Proposed actions; may not be released." />
      <Metric label="Redactions page-attested" value={summary.redactionsPageAttested} note="Page reported local acceptance; not proof of enforcement." />
    </section>
    <section className="grid-two">
      <article className="panel"><h2>Coverage</h2><p>{summary.coverageNote}</p>
        <p><strong>{summary.observedDevices}</strong> registered devices observed · <strong>{summary.freshDevices}</strong> recent · <strong>{summary.staleDevices}</strong> stale</p>
        <p className="muted">Unregistered devices are not monitored. Stale means not recently observed, not uninstalled or non-compliant.</p>
        {!!bestEffort.length && <p className="warning">Best-effort text protection enabled for: {bestEffort.map((domain) => domain.siteId).join(", ")}. Page changes or unrecognized workflows can bypass coverage.</p>}
        {!!unsupported.length && <p className="warning">Unsupported domains observed: {unsupported.map((domain) => domain.siteId).join(", ")}. Activity may be visible, but submissions are unprotected.</p>}
      </article>
      <article className="panel"><h2>Trend · visits and protection outcomes</h2>
        {!series?.buckets.length ? <p className="muted">No trend data available.</p> : <div className="bars">{series.buckets.map((bucket) => <div className="bar-row" key={bucket.bucketDateLocal}><time>{bucket.bucketDateLocal.slice(5)}</time><span>Visits <b style={{ width: `${Math.min(100, bucket.siteVisitsObserved * 10)}%` }} /></span><span>Sandbox <b className="green" style={{ width: `${Math.min(100, bucket.guardedAttempts * 10)}%` }} /></span><span>Best-effort <b className="gold" style={{ width: `${Math.min(100, bucket.bestEffortAttempts * 10)}%` }} /></span><span>Redactions confirmed <b className="gold" style={{ width: `${Math.min(100, bucket.redactionsPageAttested * 20)}%` }} /></span></div>)}</div>}
        {series && <small className="muted">{series.timezone} local dates. Visits, sandbox submissions, provider best-effort submissions, and page-attested redactions are separate measures.</small>}
      </article>
    </section>
    <section className="panel"><h2>Device last seen</h2><p className="muted">Server-ingested heartbeat/event timestamps for registered devices only.</p>
      <div className="privacy-row"><label htmlFor="device-label">New device label</label><input id="device-label" maxLength={100} value={deviceLabel} onChange={(event) => setDeviceLabel(event.target.value)} placeholder="e.g. Office browser 1" /><button disabled={enrollingDevice || !deviceLabel.trim()} onClick={() => void enrollDevice()}>{enrollingDevice ? "Enrolling…" : "Enroll device"}</button></div>
      {issuedCredential && <div className="warning" role="status"><strong>Copy these values now; the bearer credential is shown only once.</strong><p>In extension settings, enter the device ID, bearer token, and policy key fingerprint. Treat the token like a password; compare the fingerprint to the Policy page.</p><p>Device ID: <code>{issuedCredential.deviceId}</code></p><p>Bearer token: <code className="credential-value">{issuedCredential.token}</code></p><p>Policy key fingerprint: <code className="credential-value">{issuedCredential.policyKeyId}</code></p><button onClick={() => setIssuedCredential(null)}>Hide credential</button></div>}
      {!devices?.items.length ? <p>No registered devices reported.</p> : <ul className="device-list">{devices.items.map((device) => <li key={device.deviceId}><code>{device.deviceId.slice(0, 8)}…</code><span>{device.enrollmentStatus === "REVOKED" ? "Revoked · enrollment disabled" : device.observation === "STALE" ? "Active · stale" : device.observation === "NEVER_SEEN" ? "Active · never seen" : "Active · recently seen"}</span><time>{device.lastHeartbeatAt ?? "No heartbeat recorded"}</time>{device.enrollmentStatus === "ACTIVE" && <button disabled={revokingDeviceId === device.deviceId} onClick={() => void revokeDevice(device.deviceId)}>{revokingDeviceId === device.deviceId ? "Revoking…" : "Revoke device"}</button>}</li>)}</ul>}
      {deviceActionError && <p className="error" role="alert">{deviceActionError}</p>}
    </section>
  </>;
}
