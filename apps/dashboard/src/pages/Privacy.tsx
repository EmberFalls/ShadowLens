import { useEffect, useState } from "react";
import type { DataClient, RetentionSettings } from "../api/types.js";

export function Privacy({ client, onEventsDeleted }: { client: DataClient; onEventsDeleted: () => void }) {
  const [settings, setSettings] = useState<RetentionSettings | null>(null);
  const [days, setDays] = useState("30");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    client.getRetentionSettings().then((value) => {
      if (active) { setSettings(value); setDays(String(value.retentionDays)); }
    }).catch(() => { if (active) setError("Privacy settings could not be loaded."); });
    return () => { active = false; };
  }, [client]);

  async function saveRetention() {
    const parsed = Number(days);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3650) {
      setError("Choose a whole number from 1 to 3650 days.");
      return;
    }
    setBusy(true); setError(null); setMessage(null);
    try {
      const updated = await client.setRetentionDays(parsed);
      const current = await client.getRetentionSettings();
      setSettings(current);
      setMessage(`Retention is now ${updated.retentionDays} days. ${updated.expiredEventsDeleted} expired event(s) were removed immediately.`);
    } catch { setError("The retention setting could not be saved."); }
    finally { setBusy(false); }
  }

  async function exportMetadata() {
    setBusy(true); setError(null); setMessage(null);
    try {
      const data = await client.exportMetadata();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = "shadowlens-metadata-export.json"; link.click();
      URL.revokeObjectURL(url);
      setMessage(`Exported ${data.events.length} event(s), ${data.devices.length} device record(s), ${data.domains.length} domain setting(s), policy and audit data. Prompt contents and bearer credentials are not included.`);
    } catch { setError("Metadata export failed."); }
    finally { setBusy(false); }
  }

  async function deleteHistory() {
    if (!window.confirm("Delete all stored event history? Device enrollment and tool approval settings will remain.")) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      const result = await client.deleteEventHistory();
      setMessage(`Deleted ${result.deletedEvents} event(s).`);
      onEventsDeleted();
    } catch { setError("Event history could not be deleted."); }
    finally { setBusy(false); }
  }

  return <section className="panel privacy-controls">
    <h2>Metadata retention</h2>
    <p className="muted">ShadowLens stores event metadata, not prompt text. A shorter window is applied immediately; older events are permanently removed.</p>
    <div className="privacy-row"><label htmlFor="retention-days">Keep event metadata for (days)</label><input id="retention-days" type="number" min="1" max="3650" step="1" value={days} onChange={(event) => setDays(event.target.value)} /><button disabled={busy || !settings} onClick={saveRetention}>Save retention</button></div>
    {settings && <p className="muted">Current setting: {settings.retentionDays} days{settings.updatedAt ? ` · updated ${new Date(settings.updatedAt).toLocaleString()}` : ""}</p>}
    <h2>Owner data controls</h2>
    <p className="muted">Export includes sanitized event metadata, device labels and lifecycle timestamps, domain approvals, owner policy and audit history. It excludes prompts and bearer credentials. Deleting event history keeps device enrollment and tool approval preferences.</p>
    <div className="privacy-row"><button disabled={busy} onClick={exportMetadata}>Download metadata export</button><button className="danger" disabled={busy} onClick={deleteHistory}>Delete event history</button></div>
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
