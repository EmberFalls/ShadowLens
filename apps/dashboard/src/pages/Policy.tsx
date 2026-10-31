import { useEffect, useState } from "react";
import { analyze, type PolicyConfig } from "@shadowshield/engine";
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
  const [simulation, setSimulation] = useState<Array<{ label: string; action: string; findings: string[] }> | null>(null);
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

  function simulate() {
    let draftRules: Omit<PolicyDraft, "protectedTerms">;
    try { draftRules = JSON.parse(json) as Omit<PolicyDraft, "protectedTerms">; }
    catch { setSimulation(null); setError("Policy JSON is invalid; correct it before previewing."); return; }
    const terms = parseProtectedTerms(protectedTerms);
    if (!terms) { setSimulation(null); setError("Enter up to 100 unique phrases, each 3–100 printable characters, one per line."); return; }
    if (!policy) return;
    const candidate = {
      contractVersion: "v2" as const,
      revision: policy.revision,
      updatedAt: new Date().toISOString(),
      ...draftRules,
      protectedTerms: terms,
    } as PolicyConfig;
    const examples = [
      { label: "Routine business request", text: "Summarize the public launch checklist and list its three milestones." },
      { label: "Synthetic contact detail", text: "For this demo, contact the sample user at person@shop.invalid." },
      { label: "Synthetic private key", text: "-----BEGIN PRIVATE KEY-----\nSYNTHETIC_ONLY\n-----END PRIVATE KEY-----" },
      { label: "Confidentiality marker", text: "CONFIDENTIAL: review the sample project roadmap." },
      ...(terms[0] ? [{ label: "Configured business term", text: `Synthetic policy preview for ${terms[0]}.` }] : []),
    ];
    try {
      const result = examples.map(({ label, text }) => {
        const output = analyze({ text, policy: candidate });
        return { label, action: output.decision.action, findings: [...new Set(output.detection.findings.map((finding) => finding.category))] };
      });
      setError(null);
      setSimulation(result);
    } catch {
      setSimulation(null);
      setError("Policy could not be simulated. Check supported fields and keep the required private-key block rule enabled.");
    }
  }

  return <section className="panel">
    <h2>Owner policy</h2>
    <p className="muted">Policy revisions are signed by this installation. Connected extensions verify signatures locally before using a revision. Private-key findings remain blocked and cannot be weakened here. Business terms are delivered in the signed policy and scanned on enrolled browsers; matched text is never included in usage events.</p>
    {policy && <p>Current revision: <strong>{policy.revision}</strong> · Updated: {new Date(policy.updatedAt).toLocaleString()}</p>}
    <label htmlFor="owner-protected-terms">Business protected terms</label>
    <p className="muted">One customer, project, or internal term per line. Each term is stored by this owner service and copied to enrolled browser profiles for local scanning.</p>
    <textarea id="owner-protected-terms" rows={6} maxLength={10099} spellCheck={false} value={protectedTerms} onChange={(event) => { setProtectedTerms(event.target.value); setSimulation(null); }} placeholder={"Project Atlas\nCustomer Acme"} />
    <label htmlFor="owner-policy-json">Policy rules (JSON)</label>
    <textarea id="owner-policy-json" className="policy-editor" spellCheck={false} value={json} onChange={(event) => { setJson(event.target.value); setSimulation(null); }} />
    <button disabled={busy || !policy} onClick={() => void save()}>{busy ? "Saving…" : "Save and sign policy"}</button>
    <section className="policy-simulator" aria-labelledby="policy-simulator-title">
      <h2 id="policy-simulator-title">Policy simulator</h2>
      <p className="muted">Preview the unsaved rules against synthetic examples in this browser. Prompt text and matched business terms are not sent to the service, saved, or shown in results. This is a small sanity check, not an evaluation or protection guarantee.</p>
      <button type="button" className="secondary" disabled={!policy} onClick={simulate}>Preview current draft</button>
      {simulation && <div className="table-wrap"><table aria-label="Synthetic policy preview"><thead><tr><th>Example</th><th>Detected categories</th><th>Draft action</th></tr></thead><tbody>{simulation.map((item) => <tr key={item.label}><td>{item.label}</td><td>{item.findings.length ? item.findings.join(", ") : "None"}</td><td><strong>{item.action}</strong></td></tr>)}</tbody></table></div>}
    </section>
    <h2>Device trust fingerprint</h2>
    <p className="muted">Compare this value with the fingerprint shown when enrolling a browser, then enter it in that browser’s extension settings.</p>
    {key && <p><code className="credential-value">{key.keyId}</code> <button onClick={() => void copyFingerprint()}>Copy fingerprint</button></p>}
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
    <button className="secondary" disabled={busy} onClick={() => { setError(null); setMessage(null); void refresh().catch(() => setError("Could not reload the owner policy.")); }}>Reload policy</button>
  </section>;
}
