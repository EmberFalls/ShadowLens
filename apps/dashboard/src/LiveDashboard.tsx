import { useEffect, useMemo, useState } from "react";
import { ApiError, createApiClient } from "./api/client.js";
import { App } from "./App.js";

type SessionState = "checking" | "signed-out" | "signed-in" | "unavailable";

export function LiveDashboard() {
  const [session, setSession] = useState<SessionState>("checking");
  const [loginError, setLoginError] = useState("");
  const client = useMemo(() => createApiClient({ onUnauthorized: () => setSession("signed-out") }), []);

  useEffect(() => {
    void client.getCurrentSession().then(() => setSession("signed-in")).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 401) setSession("signed-out");
      else setSession("unavailable");
    });
  }, [client]);

  if (session === "checking") return <main className="auth-shell"><section className="auth-card"><h1>Checking owner session</h1><p>Connecting to the local ShadowLens service…</p></section></main>;
  if (session === "unavailable") return <main className="auth-shell"><section className="auth-card"><h1>Local service unavailable</h1><p>The live dashboard needs the local API. It will not substitute mock data.</p><button onClick={() => { setSession("checking"); void client.getCurrentSession().then(() => setSession("signed-in")).catch(() => setSession("unavailable")); }}>Retry connection</button></section></main>;
  if (session === "signed-out") return <main className="auth-shell"><form className="auth-card" onSubmit={async event => {
    event.preventDefault(); setLoginError("");
    const form = new FormData(event.currentTarget);
    const password = form.get("password");
    if (typeof password !== "string" || !password) { setLoginError("Enter the owner password."); return; }
    event.currentTarget.reset();
    try { await client.login(password); setSession("signed-in"); }
    catch (error) { setLoginError(error instanceof ApiError && error.status >= 500 ? "The local service is unavailable." : "Sign-in failed. Check the owner password and try again."); }
  }}><p className="eyebrow">LOCAL OWNER ACCESS</p><h1>Sign in to ShadowLens</h1><p>Dashboard data stays on this device. Sign-in is required to view it.</p><label htmlFor="owner-password">Owner password</label><input id="owner-password" name="password" type="password" autoComplete="current-password" required maxLength={1024} /><button type="submit">Sign in</button>{loginError && <p role="alert" className="error">{loginError}</p>}</form></main>;
  return <App client={client} mode="LIVE" onLogout={async () => { try { await client.logout(); } finally { setSession("signed-out"); } }} />;
}
