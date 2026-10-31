# ShadowLens

ShadowLens is a local-first browser extension and owner dashboard for observing AI-tool activity and guarding supported web composers. The local sandbox is guarded; ChatGPT, Gemini, and Claude text composers are covered on a best-effort basis. Dashboard approvals are informational.

## Local checks

Use Node.js 22 and Python 3.11 or newer. Install root and dashboard dependencies, then run:

```powershell
npm install
npm install --prefix apps/dashboard
npm run test:engine
npm --prefix tests/eval test
npm run test:dashboard
npm run build:dashboard
npm run test:extension:browser
```

The extension browser suite uses Playwright 1.58.2 with its bundled Chromium build. On Windows, Playwright stages an unchanged browser copy under `apps/extension/.browser-runtime` because the cached browser cannot be activated from its original location in this environment.

## Run the local demo on Windows

This starts the owner API, live dashboard, synthetic sandbox receiver, and unpacked browser extension. Use synthetic prompts only.

Install dependencies once from the repository root:

```powershell
npm install
npm install --prefix apps/dashboard
python -m pip install -e apps/api
npm run build:extension
```

In **PowerShell window 1**, initialize the local database and create the owner on the first run. Keep the same database and signing-key paths in this window each time you restart the service:

```powershell
New-Item -ItemType Directory -Force .shadowlens | Out-Null
$env:SHADOWSHIELD_DATABASE = "$PWD\.shadowlens\shadowlens.sqlite3"
$env:SHADOWSHIELD_POLICY_SIGNING_KEY = "$PWD\.shadowlens\policy-signing-key.pem"
$env:SHADOWSHIELD_CORS_ORIGINS = "http://127.0.0.1:5173"
python -m apps.api.shadow_api.db.manage init
python -m apps.api.shadow_api.db.manage provision-owner
python -m apps.api.shadow_api.main
```

`provision-owner` prompts for a password and confirmation. It should succeed only once; on later starts, set those same environment variables and run `python -m apps.api.shadow_api.main` without provisioning again. In **PowerShell window 2**, start the dashboard development server. Its Vite proxy sends `/api/v1` requests to the API:

```powershell
npm --prefix apps/dashboard run dev
```

In **PowerShell window 3**, start the sandbox receiver:

```powershell
npm run dev:sandbox
```

Open `http://127.0.0.1:5173`, sign in with the owner password, and enroll a browser in the Overview page's device section. Copy the device ID, one-time bearer token, and policy-key fingerprint shown with the enrollment. In Chrome, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `apps/extension/dist`. Open the extension's Options page; enter those three values and connect. Enable domain observation only if you want site-visit metadata. Visit `http://localhost:4173` to try the protected local receiver. The API stores sanitized event metadata; it does not store prompts.

The development dashboard is fixed to port 5173 and the sandbox to 4173. If the dashboard reports that 5173 is already in use, use the dashboard already running there or stop its prior dev-server process before starting another one. Do not change the port without also changing the API's exact development-origin allowlist and Vite proxy configuration.

The full integration harness uses a temporary SQLite database and synthetic credentials/events only:

```powershell
python -m pip install -e "apps/api[test]"
npm run test:e2e
```

It starts the local API and dashboard, rejects an event carrying a synthetic raw-prompt field, and exercises owner sign-in, live data, ChatGPT best-effort and Copilot unsupported classification, provider submission metrics, approval persistence, timezone selection, stale-device reporting, metadata-only events, and logout. It deletes its temporary database and stops both local servers when it exits.

The GitHub Actions workflow in `.github/workflows/ci.yml` runs the API tests, protected-receiver browser suite, and full local E2E on a runner with localhost access. It also runs contract, engine, extension, dashboard and evaluation checks. CI enforces the planned synthetic regression thresholds for prompt precision/recall, benign false-block rate, redaction residuals, and scan latency. Passing this gate is not independent release evidence or a production accuracy claim. Its uploaded evaluation artifact contains aggregate synthetic metrics only.

The independent evaluation protocol, external holdout storage rules, and Ed25519 reviewer-attestation commands are documented in [tests/eval/HOLDOUT.md](tests/eval/HOLDOUT.md). The checked-in holdout candidate file is explicitly unsealed and is not release evidence.

For a local database, owner retention settings persist in SQLite. The owner dashboard Privacy page can change the event window, download sanitized telemetry plus device/domain/policy configuration, and delete event history. The export excludes prompt contents and bearer credentials; employee-entered device labels are included. CLI backups use SQLite's online backup API and are integrity-checked. Each database backup is paired with a P-256 policy signing-key sidecar named `<output>.policy-key.pem`; keep both files together and protect both as sensitive business data:

```powershell
python -m apps.api.shadow_api.db.manage backup --output .\shadowlens-backup.sqlite3
python -m apps.api.shadow_api.db.manage restore --input .\shadowlens-backup.sqlite3 --pre-restore-backup .\before-restore.sqlite3
```

Stop the API before restoring. Restore loads the paired signing-key sidecar by default, validates the key and backup schema/integrity before replacing the active database, and requires a separate pre-restore database backup when the active database exists. It also creates a pre-restore signing-key sidecar next to the active database. Backups contain pseudonymous event metadata and the policy signing private key; store them together with access restricted to the business owner. Restoring only one file from the pair can break signed policy trust for enrolled browsers.

For an owner service reachable by multiple employee browsers, configure the API behind a TLS-terminating reverse proxy and set `SHADOWSHIELD_PUBLIC_ORIGIN` to its exact HTTPS origin. The API binds to loopback by default; the proxy must forward the public `Host` and `X-Forwarded-Proto: https` headers. Set `SHADOWSHIELD_TRUSTED_PROXY_IPS` to the proxy's exact IP or CIDR so Uvicorn accepts forwarded scheme/client headers only from that proxy; the launcher uses `SHADOWSHIELD_BIND_HOST` and this trust list. Do not trust arbitrary clients or `0.0.0.0/0`. The API rejects non-HTTPS requests when a public origin is configured. `SHADOWSHIELD_BIND_HOST=0.0.0.0` is accepted only when an HTTPS public origin is configured, and the API process itself does not terminate TLS. In extension settings, enter that HTTPS origin; the browser requests permission for that one host. Each browser must then be enrolled by the owner and connected with its one-time credential. Each installation serves one business and one configured owner; the CLI checks the owner ID during provisioning. For multiple businesses, use separate API processes, databases, signing keys, credentials, and HTTPS origins. Shared multi-tenant hosting is not implemented. See [the isolation boundary in the deployment runbook](docs/managed-deployment.md#business-isolation-boundary).

The dashboard Policy page lets the owner edit versioned policy rules. The API signs each policy bundle with a per-installation P-256 key; the browser verifies its fingerprint and signature locally, rejects rollback revisions, and keeps using the last signed policy when the service is unavailable. Enrollment shows the policy key fingerprint. Enter that fingerprint in the extension Options page before connecting the one-time device credential. By default the key is `policy-signing-key.pem` next to the SQLite database, or set `SHADOWSHIELD_POLICY_SIGNING_KEY` to choose another path. The backup command copies this key to a paired sidecar. Use `rotate-policy-key --backup-key <protected-path>` to replace a signing key while keeping device enrollment; restart the API and verify the new dashboard fingerprint in each browser's Options page. See the [rotation runbook](docs/managed-deployment.md#rotate-the-policy-signing-key). If the key is lost without a backup, enrollments must be re-established against the replacement fingerprint.

Run `npm run package:extension` to build a deterministic store-upload ZIP under `apps/extension/dist/`. For managed Chrome or Edge rollout, see [the deployment runbook](docs/managed-deployment.md). The repository has no published store listing or production extension ID yet; publication and managed policy configuration remain operator steps.

## Current integration status

- Owner controls include dashboard device enrollment (credential returned once; only its hash is stored), device revocation, and a metadata-only admin audit trail. The Privacy page exposes persisted event retention, immediate pruning, metadata export, and event-history deletion while retaining device enrollment and domain approval preferences. API tests and live dashboard E2E cover the owner controls.
- Privacy export includes sanitized event telemetry, device enrollment metadata without credentials, current domain approvals and approval history, owner policy, policy key fingerprint, and administrative audit. Isolated tests exercise database/key backup, restore, rotation, and rejection of invalid restore input. An operator restore drill remains a pilot requirement; tenant isolation remains unimplemented, so deploy a separate service/database/key per business.
- Owner policy editing and signed policy distribution are implemented. Owners can include business-specific `protectedTerms`; they are distributed in the signed policy, scanned locally on enrolled browsers, and never included as matched text in telemetry. The extension pins the owner-provided SHA-256 key fingerprint, verifies signed bundles, rejects expired updates and rollback or same-revision content changes, and preserves the last previously verified policy offline. Policy update is covered by E2E; key rotation/recovery still needs rehearsal. Preserve the per-installation signing key in protected backups.
- Extension service configuration now supports a user-selected HTTPS origin with permission requested for that host. Switching origins clears queued telemetry and the current device credential. API deployment accepts an exact public HTTPS origin behind a TLS proxy and enables Secure owner cookies; these remote flows have not been exercised live.
- Owner login now applies a persistent five-failures-per-15-minute address throttle. Only an HMAC fingerprint derived from the installation signing key is stored; raw client addresses are not persisted, and old throttle entries are pruned after 24 hours. Trust forwarded client addresses only from explicitly configured reverse proxies.

- Current local checks pass: contract generation/schema/fixture validation; API tests (62); dashboard tests (12) and production build; extension tests (41); engine tests (41); synthetic evaluation quality gate; full E2E (19 extension browser cases plus 3 live API/dashboard cases); and deterministic extension package build. Synthetic provider-shaped pages do not prove compatibility with current provider websites.
- The current synthetic report includes a fixed synthetic owner term and near-match negatives: development has 62/62 prompt precision and recall, 0/37 benign false warnings or blocks; the generated split has 806/806 precision and recall, 0/200 benign false warnings or blocks. These are template-correlated synthetic results, not production accuracy or independent release evidence.
- The evaluation command now has an enforced CI regression gate using the plan's initial thresholds: ≥90% prompt precision, ≥95% recall, ≤1% benign false blocks, zero residual/unsafe redaction releases, and ≤300 ms generated-set p95 scan time for inputs up to 10k characters. The current synthetic run passes; the 1,000+ generated rows remain correlated stress cases, not an independent holdout.
- G3 protected receiver and G4 API/dashboard integration pass against the local synthetic fixtures and temporary service. The API test suite also passes. This does not establish live provider-site compatibility.
- G5 independent evaluation and G6 tagged release rehearsal remain release gates; no new green tag has been created.
- ChatGPT (`chatgpt.com`), Gemini (`gemini.google.com`), and Claude (`claude.ai`) use site-specific DOM adapters. The extension scans prompt text locally, blocks on policy, reviews warnings/redactions, and requires the user to click Send a second time after approval. Provider page changes can break selectors, so coverage reports `THIRD_PARTY_BEST_EFFORT` and drops to `UNPROTECTED` if the composer is not recognized.
- File attachments, dropped/pasted files, and recognized provider voice/recording controls are blocked because their contents are not scanned. Provider adapters remain best-effort; unrecognized alternate paths are outside guaranteed coverage. Text entered into a recognized composer, including text produced by external dictation, is scanned before submission.
- MV3 extensions cannot provide an unbreakable network-level content firewall for these consumer pages. Do not present this build as covering desktop/mobile apps, API clients, hidden provider workflows, or every future page change. Release still requires the independent evaluation and tagged rehearsal listed above.

No real customer data, provider credentials, or live sensitive prompts are used by the test harness.
