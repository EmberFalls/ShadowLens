# ShadowLens

ShadowLens is a local-first browser extension and owner dashboard for observing AI-tool activity and guarding the controlled sandbox. Coverage is explicit: unsupported provider pages are observed only, and dashboard approvals are informational.

## Local checks

Use Node.js 22 and Python 3.11 or newer. Install root and dashboard dependencies, then run:

```powershell
npm install
npm install --prefix apps/dashboard
npm run test:dashboard
npm run build:dashboard
npm run test:extension:browser
```

The extension browser suite uses Playwright 1.58.2 with its bundled Chromium build. On Windows, Playwright stages an unchanged browser copy under `apps/extension/.browser-runtime` because the cached browser cannot be activated from its original location in this environment.

The full integration harness uses a temporary SQLite database and synthetic credentials/events only:

```powershell
python -m pip install -e "apps/api[test]"
npm run test:e2e
```

It starts the local API and dashboard, rejects an event carrying a synthetic raw-prompt field, and exercises owner sign-in, live data, approval persistence, timezone selection, stale-device reporting, metadata-only events, and logout. It deletes its temporary database and stops both local servers when it exits.

## Current integration status

- Dashboard unit tests: 11 passed; TypeScript check and production build passed on the current working branch.
- G3 receiver proof: the extension browser suite passed 13/13 at baseline `edcf934`; its redaction case checked the receiver and observed exactly `Contact [REDACTED_PII]`.
- G4 live API/dashboard reconciliation is blocked on the current `main` composition: analytics, domains, and devices routers exist, but `apps/api/shadow_api/main.py` does not register them in the normal application. The dashboard must show an unavailable state until the API issue owner wires those routes. The E2E gate must be rerun after that dependency lands.
- The local full-stack harness was attempted with an alternate Python that has FastAPI/Uvicorn installed, but this desktop sandbox denies loopback TCP binding. The default Python also lacks the API dependencies; set `PYTHON` to a Python environment with the `apps/api[test]` extras when running the harness elsewhere.
- G5 independent evaluation and G6 tagged release rehearsal remain release gates; no new green tag has been created.
- SH-020 provider protection is deliberately unsupported. The current protected gate and adapter contract are sandbox-specific. Do not enable or advertise a real provider adapter until the gate supports truthful per-site coverage and A2 has reviewed the release path.

No real customer data, provider credentials, or live sensitive prompts are used by the test harness.
