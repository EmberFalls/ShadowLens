# Managed browser deployment

This runbook describes the deployment steps for a small business after it has a signed extension release. The working tree currently builds the extension but does not publish it to a browser store or create a signed CRX/update service. Do not force-install a development build for company-wide use.

## Business isolation boundary

The owner service is single-business per installation. It does not scope rows for multiple businesses inside one shared database. Give each business its own API process, SQLite database, policy-signing key, owner credential, and HTTPS origin; route each business's hostname to its own API process. Never enroll devices from different businesses into the same service. The CLI rejects owner provisioning when the requested owner ID differs from `SHADOWSHIELD_OWNER_ID` or the database is already assigned to another owner. Hosted multi-tenant service is not implemented.

## Before deployment

1. Run `npm run package:extension` and review the generated `apps/extension/dist/shadowlens-store-upload.zip`. Publish that ZIP through the Chrome Web Store or Microsoft Edge Add-ons, or prepare an approved enterprise self-hosted update service. Record the extension ID and the store/update URL; the ID does not exist until the package is published or registered. The command does not publish the package or produce a signed CRX.
2. Deploy the ShadowLens API behind HTTPS, set `SHADOWSHIELD_PUBLIC_ORIGIN`, bind to loopback or the proxy-facing interface, and set `SHADOWSHIELD_TRUSTED_PROXY_IPS` to the reverse proxy's exact IP/CIDR. Provision the owner account and protect the SQLite database and `policy-signing-key.pem` with owner-only access. Keep recoverable, access-controlled copies of both.
3. Sign in to the owner dashboard, review the policy, enroll one pilot browser, and verify that the device credential is copied only to that browser. Compare the enrollment fingerprint with the Policy page and pin it in extension settings.
4. Tell employees what the extension observes and what it does not. Prompt contents are inspected in the browser and are not sent to the owner service; metadata reports supported AI-site activity and policy outcomes.

## Rotate the policy signing key

The signing key authenticates owner policies. Rotate it only when required (for example, suspected key exposure) and during a maintenance window. Keep the API stopped while replacing the key so the process cannot continue signing with its in-memory old key.

1. Stop the API. Create a database and matching key backup in a protected location. The backup command creates a `<output>.policy-key.pem` sidecar unless `--policy-key-output` is supplied:

   ```powershell
   python -m apps.api.shadow_api.db.manage backup --output C:\ShadowLensBackup\before-key-rotation.sqlite3
   ```

2. Create a separate protected copy of the old signing key and rotate. The backup destination must not already exist:

   ```powershell
   python -m apps.api.shadow_api.db.manage rotate-policy-key --backup-key C:\ShadowLensBackup\old-policy-signing-key.pem
   ```

   Record the new fingerprint printed by the command. Never share or paste either private-key file.

3. Restart the API. Sign in to the owner dashboard and confirm its Policy page shows the same new fingerprint.
4. In each enrolled browser, open the ShadowLens extension Options page, replace the fingerprint field with the dashboard's new fingerprint, and choose **Verify and trust new policy key**. The browser fetches the service public key and signed policy, checks both against the entered fingerprint, then saves the new pin and policy together. If verification fails, it retains the previous pin and policy; retry after confirming the API and fingerprint.
5. Confirm each browser reports a verified policy revision. Keep the database backup, matching key sidecar, and old key in protected storage until recovery is no longer needed.

If the device bearer credential is also suspected to be compromised, revoke that device in the owner dashboard and provision a replacement credential. Signing-key rotation alone does not rotate device credentials.

## Chrome

Use Chrome Enterprise management or the platform policy mechanism for managed Chrome browsers. Configure `ExtensionSettings` for the published extension ID with `installation_mode` set to `force_installed` and the corresponding store `update_url`. Assign the policy to a pilot organizational unit first. Google documents the [ExtensionSettings policy](https://support.google.com/chrome/a/answer/9867568) and [automatically installing extensions](https://support.google.com/chrome/a/answer/6306504).

After policy sync, confirm the policy appears in `chrome://policy` and that the extension appears on `chrome://extensions`. A store-issued extension ID and update URL are deployment inputs, so this repository cannot supply a production policy value yet.

## Microsoft Edge

Use the Microsoft Edge management service or Group Policy. Configure `ExtensionSettings` with `installation_mode: force_installed`, the published extension ID, and its store `update_url`; assign to a pilot group first. Microsoft documents [Edge extension management policies](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-manage-extensions-policies) and the [ExtensionSettings policy](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/extensionsettings).

After policy sync, confirm the policy appears in `edge://policy` and the extension is active on `edge://extensions`.

## Rehearse a paired backup restore

After creating a protected database backup and its `.policy-key.pem` sidecar, run the isolated rehearsal:

```powershell
python -m apps.api.shadow_api.db.manage restore-drill --input C:\ShadowLensBackup\shadowlens.sqlite3
```

The command restores the pair into a temporary directory, verifies SQLite integrity and schema migration, checks that the restored signing key matches the supplied sidecar, and confirms that pre-restore database/key copies work. It prints aggregate metadata counts only and removes its temporary files on exit. It does not access or change the configured active database or key, so the API may remain running. This rehearsal checks the recovery command path; before a business pilot, operators must still rehearse restoring into the actual deployment and verify that the service and enrolled browsers recover correctly.

## Pilot and rollout checks

- Enroll a small pilot group and confirm all expected devices appear in the owner dashboard. A missing, revoked, stale, or unregistered device is not proof of protection.
- Exercise only synthetic sample prompts first. Confirm allow, warn, redact, and block behavior on each currently supported provider and browser version.
- Check that the extension reports `THIRD_PARTY_BEST_EFFORT` on consumer AI providers and `UNPROTECTED` when it cannot recognize a supported composer. Do not treat observed visits as proof that every prompt submission was guarded.
- Check policy synchronization status and verify that the dashboard's policy revision matches each enrolled browser.
- Keep the prior signed extension package, policy signing key, database backup, and rollback procedure available during rollout.
- Expand deployment only after the provider compatibility, protected-receiver, API/dashboard reconciliation, independent evaluation, and backup/restore gates in the product plan are evidenced.

Managed installation makes the extension harder for an employee to remove. It does not provide network-level interception and does not cover desktop/mobile clients, direct API use, browser developer tools, uploads, or changed provider workflows.
