import { useEffect, useState } from "react";
import type { DataClient, OwnerPolicy, PolicyDraft, PolicyKeyInfo } from "../api/types.js";

function editablePolicy(policy: OwnerPolicy): Omit<PolicyDraft, "protectedTerms"> {
  return {
    defaultFindingAction: policy.defaultFindingAction,
    rules: policy.rules,
    allowWarnOverride: policy.allowWarnOverride,
  };
}

function parseProtectedTerms(text: string): string[] | null {
  const terms = text.split(/\r?\n/u).map((term) => term.trim().normalize("NFC")).filter(Boolean);
  if (terms.length > 100 || terms.some((term) => term.length < 3 || term.length > 100 || /[\u0000-\u001f\u007f]/u.test(term))) return null;
  const normalized = terms.map((term) => term.toLocaleLowerCase("en-US"));
  return new Set(normalized).size === terms.length ? terms : null;
}

export function Policy({ client }: { client: DataClient }) {
  const [policy, setPolicy] = useState<OwnerPolicy | null>(null);
  const [key, setKey] = useState<PolicyKeyInfo | null>(null);
  const [json, setJson] = useState("");
  const [protectedTerms, setProtectedTerms] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const [nextPolicy, nextKey] = await Promise.all([client.getPolicy(), client.getPolicyKey()]);
    setPolicy(nextPolicy); setKey(nextKey); setJson(JSON.stringify(editablePolicy(nextPolicy), null, 2)); setProtectedTerms((nextPolicy.protectedTerms ?? []).join("\n"));
  }

  useEffect(() => {
    let active = true;
    Promise.all([client.getPolicy(), client.getPolicyKey()]).then(([nextPolicy, nextKey]) => {
      if (!active) return;
      setPolicy(nextPolicy); setKey(nextKey); setJson(JSON.stringify(editablePolicy(nextPolicy), null, 2)); setProtectedTerms((nextPolicy.protectedTerms ?? []).join("\n"));
    }).catch(() => { if (active) setError("Owner policy could not be loaded."); });
    return () => { active = false; };
  }, [client]);

  async function save() {
    let draftRules: Omit<PolicyDraft, "protectedTerms">;
    try { draftRules = JSON.parse(json) as Omit<PolicyDraft, "protectedTerms">; }
    catch { setError("Policy JSON is invalid."); return; }
    const terms = parseProtectedTerms(protectedTerms);
    if (!terms) { setError("Enter up to 100 unique phrases, each 3–100 printable characters, one per line."); return; }
    const draft: PolicyDraft = { ...draftRules, protectedTerms: terms };
    setBusy(true); setError(null); setMessage(null);
    try {
      const saved = await client.setPolicy(draft);
      setPolicy(saved); setJson(JSON.stringify(editablePolicy(saved), null, 2)); setProtectedTerms((saved.protectedTerms ?? []).join("\n"));
      setMessage(`Policy revision ${saved.revision} saved. Enrolled browsers will fetch and verify it on their next policy sync.`);
    } catch {
      setError("Policy was rejected. Keep exactly one enabled SECRET_PRIVATE_KEY rule with LOW severity and BLOCK action, and use supported policy fields.");
    } finally { setBusy(false); }
  }

  async function copyFingerprint() {
    if (!key) return;
    try { await navigator.clipboard.writeText(key.keyId); setMessage("Policy key fingerprint copied."); }
    catch { setError("Clipboard access is unavailable. Select and copy the fingerprint manually."); }
  }

  return <section className="panel">
    <h2>Owner policy</h2>
    <p className="muted">Policy revisions are signed by this installation. Connected extensions verify signatures locally before using a revision. Private-key findings remain blocked and cannot be weakened here. Business terms are delivered in the signed policy and scanned on enrolled browsers; matched text is never included in usage events.</p>
    {policy && <p>Current revision: <strong>{policy.revision}</strong> · Updated: {new Date(policy.updatedAt).toLocaleString()}</p>}
    <label htmlFor="owner-protected-terms">Business protected terms</label>
    <p className="muted">One customer, project, or internal term per line. Each term is stored by this owner service and copied to enrolled browser profiles for local scanning.</p>
    <textarea id="owner-protected-terms" rows={6} maxLength={10099} spellCheck={false} value={protectedTerms} onChange={(event) => setProtectedTerms(event.target.value)} placeholder={"Project Atlas\nCustomer Acme"} />
    <label htmlFor="owner-policy-json">Policy rules (JSON)</label>
    <textarea id="owner-policy-json" className="policy-editor" spellCheck={false} value={json} onChange={(event) => setJson(event.target.value)} />
    <button disabled={busy || !policy} onClick={() => void save()}>{busy ? "Saving…" : "Save and sign policy"}</button>
    <h2>Device trust fingerprint</h2>
    <p className="muted">Compare this value with the fingerprint shown when enrolling a browser, then enter it in that browser’s extension settings.</p>
    {key && <p><code className="credential-value">{key.keyId}</code> <button onClick={() => void copyFingerprint()}>Copy fingerprint</button></p>}
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
    <button className="secondary" disabled={busy} onClick={() => { setError(null); setMessage(null); void refresh().catch(() => setError("Could not reload the owner policy.")); }}>Reload policy</button>
  </section>;
}
