# Release and rollback checklist

## Before marking a build green

- [ ] Record the commit SHA and target Chromium version. Current browser gate: Playwright 1.58.2 bundled Chromium.
- [ ] Run `npm run contracts:check`, `npm run test:engine`, `npm run test:extension`, `npm run test:dashboard`, `npm run build:dashboard`, and `npm run test:e2e` from a clean checkout.
- [ ] Confirm the extension browser test's receiver contains the approved redacted string and never the original sensitive sample.
- [ ] Confirm the synthetic raw sentinel is absent from the extension queue, API response/log output, and dashboard event view.
- [ ] Confirm owner sign-in blocks access while signed out, service failures never show mock data, approval changes persist, and the selected timezone is respected.
- [ ] Review observed-only and unsupported coverage wording; approval must not imply enforcement.
- [ ] Record G3, G4, G5, and G6 evidence below. Do not mark a gate green unless its real test completed.
- [ ] Tag the tested SHA as `green-YYYYMMDD-N` only after all required checks pass and the demo rehearsal succeeds.

## Known gate state for this working branch

- **G3 — receiver proof:** green in local Chromium browser tests and CI. The browser suite verifies exact redacted receiver text, blocked/fail-safe non-release, and cancellation after edits. Provider-shaped fixtures do not prove live provider compatibility.
- **G4 — telemetry and dashboard reconciliation:** green in local API/dashboard E2E on the current integration line. It verifies synthetic event ingestion, privacy rejection, provider metrics, device freshness and live dashboard behavior. Re-run on the final release SHA.
- **G5 — independent evaluator:** not recorded. A genuinely independent reviewer must author and attest a disjoint holdout, then attach the evaluator command, output, and SHA before release.
- **G6 — release rehearsal and rollback tag:** not recorded. No tag is green until G3–G5 are green and a clean-install/demo/rollback rehearsal passes.
- **G7 — provider pilot:** not recorded. Current logged-in ChatGPT, Gemini, and Claude compatibility and unsupported-path behavior still need manual verification.
- **G8 — business pilot:** not recorded. HTTPS deployment, managed browser rollout, restore drill, privacy review and per-business isolation need operator evidence.

## Rollback

1. Stop the extension/API/demo processes and identify the most recent `green-YYYYMMDD-N` tag.
2. Check out that tag in a clean worktree and verify `git rev-parse HEAD` matches the SHA recorded in the release entry.
3. Re-run the extension browser gate before the demo. Use the tagged dashboard and API from the same checkout.
4. If a small fix is needed, create a branch from the green tag and cherry-pick only the reviewed fix commit. Run all affected gates and the full E2E suite; issue a new green tag only after a complete pass.
5. Never advance the green tag after a failed gate, an unreviewed provider adapter, or an unverified API/dashboard integration.

## Release record

| Gate | SHA / tag | Result | Evidence |
| --- | --- | --- | --- |
| G3 | `19fb922` | PASS | CI and local Chromium receiver tests; rerun on release SHA |
| G4 | `19fb922` | PASS | Local API/dashboard E2E; pending rerun with device-health changes on the release SHA |
| G5 | — | NOT RUN | Independent evaluator evidence required |
| G6 | — | NOT RUN | Rehearsal and green tag required |
