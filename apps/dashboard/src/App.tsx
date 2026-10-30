import { useEffect, useState } from "react";
import type { DataClient, DomainSummaryV2, DeviceListV2, EventPageV2, SummaryV2, TimeseriesV2 } from "./api/types.js";
import { Overview } from "./pages/Overview.js";
import { Tools } from "./pages/Tools.js";
import { Events } from "./pages/Events.js";

type Page = "Overview" | "Tools" | "Events";
export function App({ client, mode = "MOCK", onLogout }: { client: DataClient; mode?: "LIVE" | "MOCK"; onLogout?: () => void }) {
  const [page, setPage] = useState<Page>("Overview");
  const [days, setDays] = useState(7);
  const [timezone, setTimezone] = useState<"UTC" | "Asia/Kolkata">("UTC");
  const [summary, setSummary] = useState<SummaryV2 | null>(null);
  const [series, setSeries] = useState<TimeseriesV2 | null>(null);
  const [domains, setDomains] = useState<DomainSummaryV2[]>([]);
  const [devices, setDevices] = useState<DeviceListV2 | null>(null);
  const [events, setEvents] = useState<EventPageV2 | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setError(null);
    Promise.all([client.getSummary(days), client.getTimeseries(days, timezone), client.getDomains(), client.getEvents(50), client.getDevices()])
      .then(([nextSummary, nextSeries, nextDomains, nextEvents, nextDevices]) => {
        if (!active) return;
        setSummary(nextSummary); setSeries(nextSeries); setDomains(nextDomains); setEvents(nextEvents); setDevices(nextDevices);
      }).catch(() => { if (active) setError(mode === "LIVE" ? "Live dashboard data is unavailable. No mock data is being shown." : "Unknown API error. Dashboard data is unavailable."); });
    return () => { active = false; };
  }, [client, days, timezone, mode]);

  return <div className="shell">
    <header className="topbar"><a className="logo" href="#overview">ShadowLens <small>OWNER DASHBOARD</small></a><div className="top-actions"><span className={mode === "LIVE" ? "mode live" : "mode"}>{mode === "LIVE" ? "LIVE DATA" : "MOCK DATA"}</span>{onLogout && <button className="logout" onClick={onLogout}>Sign out</button>}</div></header>
    <div className="layout"><aside className="sidebar"><p>WORKSPACE</p>{(["Overview", "Tools", "Events"] as Page[]).map((item) => <button key={item} className={page === item ? "nav active" : "nav"} onClick={() => setPage(item)}>{item}</button>)}<div className="side-note">Coverage is based on observed reports from registered devices.</div></aside>
      <main><div className="page-heading"><div><p className="eyebrow">PRIVACY OPERATIONS</p><h1>{page}</h1><p>Visibility is limited to metadata that registered devices report.</p></div>
        <div className="filters"><label>Window <select value={days} onChange={(event) => setDays(Number(event.target.value))}><option value={7}>7 days</option><option value={14}>14 days</option><option value={30}>30 days</option></select></label><label>Timezone <select value={timezone} onChange={(event) => setTimezone(event.target.value as "UTC" | "Asia/Kolkata")}><option value="UTC">UTC</option><option value="Asia/Kolkata">Asia/Kolkata</option></select></label></div>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      {page === "Overview" && <Overview summary={summary} series={series} domains={domains} devices={devices} />}
      {page === "Tools" && <Tools domains={domains} client={client} timezone={timezone} onUpdated={(updated) => setDomains((current) => current.map((domain) => domain.siteId === updated.siteId ? updated : domain))} />}
      {page === "Events" && <Events page={events} timezone={timezone} />}
      <footer>Counts describe observed events. Approval labels do not claim enforcement.</footer>
    </main></div>
  </div>;
}
