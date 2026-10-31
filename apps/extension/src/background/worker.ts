import { analyze, validatePolicy, verifyRedaction, type PolicyConfig } from "../../../../packages/engine/src/index.js";
import { DEFAULT_POLICY } from "../../../../packages/engine/src/default-policy.js";
import { installDomainObserver, type ObservationEvent } from "./domain-observer.js";
import { API_BASE_URL, DEFAULT_API_ORIGIN, EventApiClient, apiPatternForOrigin, normalizeApiOrigin, retryDelayMs, type DeviceCredential } from "./api-client.js";
import { PrivacySafeQueue, RETRY_STORAGE_KEY, type StorageArea } from "./queue.js";

type Coverage = { mode: "SANDBOX_GUARDED" | "THIRD_PARTY_BEST_EFFORT" | "UNPROTECTED" | "UNSUPPORTED"; label: string };
type ConnectionStatus = { connected: boolean; reconnectRequired: boolean; message: string };
type SessionStore = {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
};
type LocalStore = StorageArea & { get(keys: string[]): Promise<Record<string, unknown>>; remove(keys: string[]): Promise<void> };
const SESSION_CREDENTIAL_KEY = "deviceCredential";
const LOCAL_DEVICE_ID_KEY = "shadowshieldProvisionedDeviceId";
const API_ORIGIN_KEY = "shadowshieldOwnerServiceOrigin";
const DOMAIN_OBSERVATION_KEY = "shadowshieldDomainObservationEnabled";
const LOCAL_CUSTOM_TERMS_KEY = "shadowshieldLocalCustomTerms";
const LOCAL_POLICY_REVISION_KEY = "shadowshieldLocalPolicyRevision";
const LOCAL_POLICY_KEY_ID_KEY = "shadowshieldPolicyKeyId";
const SIGNED_POLICY_BUNDLE_KEY = "shadowshieldSignedPolicyBundle";
const SIGNED_POLICY_PUBLIC_KEY_KEY = "shadowshieldPolicyPublicKey";
const SIGNED_POLICY_REVISION_KEY = "shadowshieldSignedPolicyRevision";
const SIGNED_POLICY_DIGEST_KEY = "shadowshieldSignedPolicyDigest";
const BACKOFF_ALARM = "shadowlens-event-flush-backoff";
const POLICY_REFRESH_ALARM = "shadowlens-policy-refresh";
const SESSION_DEVICE_ID_KEY = "deviceId";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE_TOKEN = /^[A-Za-z0-9_-]{32,512}$/;
const EXTENSION_VERSION = (() => {
  try {
    const version = chrome.runtime.getManifest().version;
    return /^[A-Za-z0-9.+_-]{1,32}$/.test(version) ? version : "0.0.0";
  } catch { return "0.0.0"; }
})();
const coverageByTab = new Map<number, Coverage>();
const localStore = chrome.storage.local as unknown as LocalStore;
const sessionStore = chrome.storage.session as unknown as SessionStore;
const queue = new PrivacySafeQueue(localStore);
let credential: DeviceCredential | null = null;
let deviceId: string | null = null;
let domainObservationEnabled = false;
let reconnectRequired = true;
let connected = false;
let flushInProgress = false;
let retryAttempt = 0;
let retryAt = 0;
let initialization: Promise<void> | null = null;
let credentialGeneration = 0;
let configurationSwitching = false;
let policySyncMessage = "No signed policy has been synchronized.";
let policySyncInProgress = false;
let verifiedPolicyCache: { cacheKey: string; policy: PolicyConfig } | null = null;

void chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
void chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });

function parseCredential(message: { token?: unknown; deviceId?: unknown }): { token: string; deviceId: string | null } | null {
  if (typeof message.token !== "string" || message.token.length > 600 || message.token.trim() !== message.token) return null;
  let token = message.token;
  let candidateId = message.deviceId;
  if (candidateId === undefined) {
    // The existing Options page has one input. Accept the provisioned pair in
    // one field as `<device UUID>:<bearer token>` without inventing an ID.
    const separator = token.indexOf(":");
    if (separator < 0) return DEVICE_TOKEN.test(token) ? { token, deviceId: null } : null;
    candidateId = token.slice(0, separator);
    token = token.slice(separator + 1);
  }
  if (typeof candidateId !== "string" || !UUID.test(candidateId) || !DEVICE_TOKEN.test(token)) return null;
  return { token, deviceId: candidateId };
}

async function getCredential(): Promise<DeviceCredential | null> {
  if (credential) return credential;
  try {
    const values = await sessionStore.get([SESSION_CREDENTIAL_KEY, SESSION_DEVICE_ID_KEY]);
    const token = values[SESSION_CREDENTIAL_KEY];
    const storedId = values[SESSION_DEVICE_ID_KEY];
    if (typeof token !== "string" || !DEVICE_TOKEN.test(token)) return null;
    const candidateId = typeof storedId === "string" && UUID.test(storedId) ? storedId : deviceId;
    if (!candidateId) return null;
    credential = { token, deviceId: candidateId };
    deviceId = candidateId;
    reconnectRequired = false;
    return credential;
  } catch { return null; }
}

async function getApiBaseURL(): Promise<string> {
  const values = await localStore.get([API_ORIGIN_KEY]);
  const stored = values[API_ORIGIN_KEY];
  if (stored === undefined) return API_BASE_URL;
  const origin = normalizeApiOrigin(stored);
  if (!origin) throw new Error("service origin invalid");
  return `${origin}/api/v1`;
}

const apiClient = new EventApiClient(queue, getCredential, undefined, getApiBaseURL);

function setAlarm(name: string, delayMs: number): void {
  const alarmApi = chrome.alarms as unknown as { create(name: string, info: { delayInMinutes?: number; periodInMinutes?: number }): void };
  alarmApi.create(name, { delayInMinutes: Math.max(0.5, delayMs / 60_000) });
}

async function flushQueue(): Promise<void> {
  if (configurationSwitching) return;
  if (Date.now() < retryAt) return;
  if (flushInProgress) return;
  flushInProgress = true;
  try {
    const activeCredential = await getCredential();
    if (!activeCredential) { reconnectRequired = true; connected = false; return; }
    while (true) {
      const result = await apiClient.flushOneBatch();
      if (result === "sent" || result === "quarantined") continue;
      if (result === "retry") {
        retryAttempt = Math.min(retryAttempt + 1, 10);
        const delay = retryDelayMs(retryAttempt);
        retryAt = Date.now() + delay;
        await localStore.set({ [RETRY_STORAGE_KEY]: { attempt: retryAttempt, retryAt } });
        setAlarm(BACKOFF_ALARM, delay);
        reconnectRequired = false;
        connected = false;
      } else if (result === "reconnect") {
        reconnectRequired = true;
        connected = false;
        credential = null;
        await sessionStore.remove([SESSION_CREDENTIAL_KEY, SESSION_DEVICE_ID_KEY]).catch(() => {});
      } else {
        retryAttempt = 0;
        retryAt = 0;
        await localStore.set({ [RETRY_STORAGE_KEY]: null });
        connected = true;
      }
      break;
    }
  } catch {
    retryAttempt = Math.min(retryAttempt + 1, 10);
    const delay = retryDelayMs(retryAttempt);
    retryAt = Date.now() + delay;
    await localStore.set({ [RETRY_STORAGE_KEY]: { attempt: retryAttempt, retryAt } }).catch(() => {});
    setAlarm(BACKOFF_ALARM, delay);
    connected = false;
  } finally {
    flushInProgress = false;
  }
}

const optionalChrome = chrome as unknown as {
  webNavigation?: { onCommitted: { addListener: (callback: (details: any) => void, filter?: unknown) => void; removeListener: (callback: (details: any) => void) => void } };
  alarms?: { create: (name: string, info: { periodInMinutes: number }) => void; clear: (name: string) => unknown; onAlarm: { addListener: (callback: (alarm: { name: string }) => void) => void; removeListener?: (callback: (alarm: { name: string }) => void) => void } };
  permissions?: { contains: (permissions: { origins?: string[] }, callback: (granted: boolean) => void) => void };
};
const navEvents = optionalChrome.webNavigation?.onCommitted ?? { addListener: () => {}, removeListener: () => {} };
const alarms = optionalChrome.alarms ?? { create: () => {}, clear: () => false, onAlarm: { addListener: () => {} } };
alarms.create(POLICY_REFRESH_ALARM, { periodInMinutes: 720 });

const observer = installDomainObserver({
  enabled: false,
  getDeviceId: () => deviceId,
  extensionVersion: EXTENSION_VERSION,
  enqueue: async (event: ObservationEvent) => {
    if (!domainObservationEnabled) return { queued: false };
    if (!deviceId) return { queued: false };
    const result = await queue.enqueue(event, deviceId);
    if (result.queued) void flushQueue();
    return result;
  },
  navigation: { onCommitted: navEvents },
  alarms: {
    create: (name, info) => alarms.create(name, info),
    clear: (name) => alarms.clear(name),
    onAlarm: {
      addListener: (callback: (alarm: { name: string }) => void) => alarms.onAlarm.addListener(callback),
      removeListener: (callback: (alarm: { name: string }) => void) => { alarms.onAlarm.removeListener?.(callback); },
    },
  },
});

function initialize(): Promise<void> {
  if (initialization) return initialization;
  initialization = (async () => {
    const generationAtStart = credentialGeneration;
    const [session, local] = await Promise.all([
      sessionStore.get([SESSION_CREDENTIAL_KEY, SESSION_DEVICE_ID_KEY]),
      localStore.get([LOCAL_DEVICE_ID_KEY, RETRY_STORAGE_KEY, DOMAIN_OBSERVATION_KEY, LOCAL_POLICY_KEY_ID_KEY]),
    ]);
    const savedCredential = session[SESSION_CREDENTIAL_KEY];
    const sessionDeviceId = session[SESSION_DEVICE_ID_KEY];
    const savedId = local[LOCAL_DEVICE_ID_KEY];
    const savedRetry = local[RETRY_STORAGE_KEY] as { attempt?: unknown; retryAt?: unknown } | null;
    domainObservationEnabled = local[DOMAIN_OBSERVATION_KEY] === true;
    if (savedRetry && typeof savedRetry.attempt === "number" && Number.isSafeInteger(savedRetry.attempt)
      && typeof savedRetry.retryAt === "number" && Number.isFinite(savedRetry.retryAt)) {
      retryAttempt = Math.min(10, Math.max(0, Number(savedRetry.attempt)));
      retryAt = Number(savedRetry.retryAt) > Date.now() ? Number(savedRetry.retryAt) : 0;
    }
    const token = typeof savedCredential === "string" && DEVICE_TOKEN.test(savedCredential) ? savedCredential : null;
    if (credentialGeneration === generationAtStart) {
      deviceId = typeof sessionDeviceId === "string" && UUID.test(sessionDeviceId)
        ? sessionDeviceId
        : typeof savedId === "string" && UUID.test(savedId) ? savedId : null;
      if (token && deviceId) {
        credential = { token, deviceId };
        reconnectRequired = false;
        await localStore.set({ [LOCAL_DEVICE_ID_KEY]: deviceId });
        observer.setEnabled(local[DOMAIN_OBSERVATION_KEY] === true);
        void flushQueue();
        if (typeof local[LOCAL_POLICY_KEY_ID_KEY] === "string") void syncSignedPolicy();
      } else {
        credential = null;
        reconnectRequired = true;
        observer.setEnabled(local[DOMAIN_OBSERVATION_KEY] === true);
      }
    }
  })();
  return initialization;
}

void initialize().catch(() => { reconnectRequired = true; });

async function readConnectionStatus(): Promise<ConnectionStatus> {
  const activeCredential = await getCredential();
  if (!activeCredential) return { connected: false, reconnectRequired: true, message: "Owner service configured; connect this browser with its device credential." };
  try {
    const apiBase = await getApiBaseURL();
    const response = await fetch(`${apiBase}/health`, { method: "GET", cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(10_000) });
    connected = response.ok;
  } catch { connected = false; }
  return {
    connected,
    reconnectRequired,
    message: reconnectRequired ? "Reconnect this browser session with its device credential." : connected ? "Connected to the configured owner service." : "Owner service is unavailable; queued events will retry.",
  };
}

function hasHostPermission(origin: string): Promise<boolean> {
  if (origin === DEFAULT_API_ORIGIN) return Promise.resolve(true);
  const permissions = optionalChrome.permissions;
  if (!permissions) return Promise.resolve(false);
  return new Promise((resolve) => {
    try { permissions.contains({ origins: [apiPatternForOrigin(origin)] }, resolve); }
    catch { resolve(false); }
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  if (message.type === "COVERAGE_UPDATE") {
    if (sender.tab?.id !== undefined && isSupportedContentUrl(sender.url) && isCoverage(message.coverage)) {
      coverageByTab.set(sender.tab.id, message.coverage);
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "GET_COVERAGE") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      void readConnectionStatus().then((connection) => sendResponse({
        coverage: tabId === undefined ? undefined : coverageByTab.get(tabId) ?? { mode: "UNPROTECTED", label: "No protected tab detected" },
        connection,
      }));
    });
    return true;
  }

  if (message.type === "GET_API_ORIGIN") {
    if (sender.url !== chrome.runtime.getURL("options/index.html")) { sendResponse({ origin: null }); return false; }
    void localStore.get([API_ORIGIN_KEY]).then((values) => {
      const origin = values[API_ORIGIN_KEY] === undefined ? DEFAULT_API_ORIGIN : normalizeApiOrigin(values[API_ORIGIN_KEY]);
      sendResponse({ origin });
    }).catch(() => sendResponse({ origin: null }));
    return true;
  }

  if (message.type === "SET_API_ORIGIN") {
    if (sender.url !== chrome.runtime.getURL("options/index.html")) { sendResponse({ ok: false }); return false; }
    const origin = normalizeApiOrigin(message.origin);
    if (!origin) { sendResponse({ ok: false, reason: "INVALID_ORIGIN" }); return false; }
    void (async () => {
      if (!await hasHostPermission(origin)) { sendResponse({ ok: false, reason: "HOST_PERMISSION_REQUIRED" }); return; }
      const configured = await localStore.get([API_ORIGIN_KEY]);
      const storedOrigin = configured[API_ORIGIN_KEY] === undefined ? DEFAULT_API_ORIGIN : normalizeApiOrigin(configured[API_ORIGIN_KEY]);
      if (storedOrigin === origin) { sendResponse({ ok: true, unchanged: true }); return; }
      configurationSwitching = true;
      try {
        while (flushInProgress) await new Promise((resolve) => setTimeout(resolve, 10));
        // Prevent queued metadata and credentials for one business from crossing
        // into another owner's service when the destination changes.
        await queue.clearForEndpointChange();
        await sessionStore.remove([SESSION_CREDENTIAL_KEY, SESSION_DEVICE_ID_KEY]);
        await localStore.remove([LOCAL_DEVICE_ID_KEY, LOCAL_POLICY_KEY_ID_KEY, SIGNED_POLICY_BUNDLE_KEY, SIGNED_POLICY_PUBLIC_KEY_KEY]);
        await localStore.set({ [API_ORIGIN_KEY]: origin, [DOMAIN_OBSERVATION_KEY]: false, [RETRY_STORAGE_KEY]: null });
        credential = null; deviceId = null; connected = false; reconnectRequired = true; verifiedPolicyCache = null;
        domainObservationEnabled = false; observer.setEnabled(false);
        retryAttempt = 0; retryAt = 0;
        void alarms.clear(BACKOFF_ALARM);
        sendResponse({ ok: true, unchanged: false, queuedMetadataDiscarded: true, reconnectRequired: true });
      } finally { configurationSwitching = false; }
    })().catch(() => sendResponse({ ok: false, reason: "SAVE_FAILED" }));
    return true;
  }

  if (message.type === "GET_CONNECTION_STATUS") {
    void readConnectionStatus().then(sendResponse).catch(() => sendResponse({ connected: false, reconnectRequired: true, message: "Owner service connection is not configured." }));
    return true;
  }

  if (message.type === "GET_POLICY_SYNC_STATUS") {
    if (sender.url !== chrome.runtime.getURL("options/index.html")) { sendResponse({ message: "Unavailable" }); return false; }
    sendResponse({ message: policySyncMessage });
    return false;
  }

  if (message.type === "SYNC_POLICY_NOW") {
    if (sender.url !== chrome.runtime.getURL("options/index.html")) { sendResponse({ ok: false, message: "Unavailable" }); return false; }
    void syncSignedPolicy().then((ok) => sendResponse({ ok, message: policySyncMessage }));
    return true;
  }

  if (message.type === "ROTATE_POLICY_KEY") {
    if (sender.url !== chrome.runtime.getURL("options/index.html")) { sendResponse({ ok: false, message: "Unavailable" }); return false; }
    const nextKeyId = typeof message.keyId === "string" ? message.keyId.trim().toLowerCase() : "";
    if (!/^[0-9a-f]{64}$/.test(nextKeyId)) { sendResponse({ ok: false, message: "Enter the 64-character fingerprint shown by the owner." }); return false; }
    void syncSignedPolicy(nextKeyId).then((ok) => sendResponse({ ok, message: ok ? "New policy key verified and saved. The existing device credential remains active." : policySyncMessage }));
    return true;
  }

  if (message.type === "GET_DOMAIN_OBSERVATION") {
    if (sender.url !== chrome.runtime.getURL("options/index.html")) { sendResponse({ enabled: false }); return false; }
    void initialize().then(async () => {
      const values = await localStore.get([DOMAIN_OBSERVATION_KEY]);
      domainObservationEnabled = values[DOMAIN_OBSERVATION_KEY] === true;
      sendResponse({ enabled: values[DOMAIN_OBSERVATION_KEY] === true });
    }).catch(() => sendResponse({ enabled: false }));
    return true;
  }

  if (message.type === "SET_DOMAIN_OBSERVATION") {
    if (sender.url !== chrome.runtime.getURL("options/index.html") || typeof message.enabled !== "boolean") {
      sendResponse({ ok: false }); return false;
    }
    void initialize().then(async () => {
      await localStore.set({ [DOMAIN_OBSERVATION_KEY]: message.enabled });
      domainObservationEnabled = message.enabled;
      observer.setEnabled(message.enabled && Boolean(deviceId));
      sendResponse({ ok: true, enabled: message.enabled });
    }).catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === "GET_CUSTOM_TERMS") {
    if (sender.url !== chrome.runtime.getURL("options/index.html")) { sendResponse({ terms: [], revision: 1 }); return false; }
    void localStore.get([LOCAL_CUSTOM_TERMS_KEY, LOCAL_POLICY_REVISION_KEY]).then((values) => {
      sendResponse({ terms: validateCustomTerms(values[LOCAL_CUSTOM_TERMS_KEY]) ?? [], revision: policyRevision(values[LOCAL_POLICY_REVISION_KEY]) });
    }).catch(() => sendResponse({ terms: [], revision: 1 }));
    return true;
  }

  if (message.type === "SET_CUSTOM_TERMS") {
    if (sender.url !== chrome.runtime.getURL("options/index.html")) { sendResponse({ ok: false }); return false; }
    const terms = validateCustomTerms(message.terms);
    if (!terms) { sendResponse({ ok: false, reason: "INVALID_TERMS" }); return false; }
    void localStore.get([LOCAL_CUSTOM_TERMS_KEY, LOCAL_POLICY_REVISION_KEY]).then(async (values) => {
      const previous = validateCustomTerms(values[LOCAL_CUSTOM_TERMS_KEY]) ?? [];
      const revision = policyRevision(values[LOCAL_POLICY_REVISION_KEY]);
      if (JSON.stringify(previous) !== JSON.stringify(terms)) {
        await localStore.set({ [LOCAL_CUSTOM_TERMS_KEY]: terms, [LOCAL_POLICY_REVISION_KEY]: revision + 1 });
        sendResponse({ ok: true, terms, revision: revision + 1 });
      } else sendResponse({ ok: true, terms, revision });
    }).catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === "SIMULATE_POLICY") {
    if (sender.url !== chrome.runtime.getURL("options/index.html")) { sendResponse({ ok: false }); return false; }
    void runtimePolicy().then(({ policy, customTerms }) => {
      const examples = [
        "Summarize this public weather report for tomorrow.",
        "Contact the customer at person@example.invalid about the order.",
        "-----BEGIN PRIVATE KEY-----\nsynthetic-fixture-only\n-----END PRIVATE KEY-----",
        "CONFIDENTIAL synthetic quarterly planning notes.",
        "const demo = async () => { return 'synthetic code'; };",
        ...(policy.protectedTerms ?? []).map((term) => `Synthetic owner-policy check: ${term}`),
        ...customTerms.map((term) => `Synthetic policy check: ${term}`),
      ];
      const actions: Record<string, number> = { ALLOW: 0, WARN: 0, REDACT: 0, BLOCK: 0 };
      const categories: Record<string, number> = {};
      for (const text of examples) {
        const analysis = analyze({ text, policy, customTerms });
        actions[analysis.decision.action]++;
        for (const [category, count] of Object.entries(analysis.detection.categoryCounts)) categories[category] = (categories[category] ?? 0) + count;
      }
      sendResponse({ ok: true, revision: policy.revision, sampleCount: examples.length, actions, categories });
    }).catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === "SET_DEVICE_CREDENTIAL") {
    if (sender.url !== chrome.runtime.getURL("options/index.html")) { sendResponse({ ok: false }); return false; }
    const parsed = parseCredential(message);
    const keyId = typeof message.policyKeyId === "string" ? message.policyKeyId.toLowerCase() : "";
    if (!parsed || !/^[0-9a-f]{64}$/.test(keyId)) { sendResponse({ ok: false }); return false; }
    credentialGeneration++;
    void (async () => {
      await sessionStore.set(parsed.deviceId
        ? { [SESSION_CREDENTIAL_KEY]: parsed.token, [SESSION_DEVICE_ID_KEY]: parsed.deviceId }
        : { [SESSION_CREDENTIAL_KEY]: parsed.token });
      if (parsed.deviceId) deviceId = parsed.deviceId;
      else if (!deviceId && localStore && typeof localStore.get === "function") {
        const localIdentity = await localStore.get([LOCAL_DEVICE_ID_KEY]);
        if (typeof localIdentity[LOCAL_DEVICE_ID_KEY] === "string" && UUID.test(localIdentity[LOCAL_DEVICE_ID_KEY] as string)) {
          deviceId = localIdentity[LOCAL_DEVICE_ID_KEY] as string;
        }
      }
      const pinnedValues = await localStore.get([LOCAL_POLICY_KEY_ID_KEY]);
      if (pinnedValues[LOCAL_POLICY_KEY_ID_KEY] !== keyId) {
        await localStore.remove([SIGNED_POLICY_BUNDLE_KEY, SIGNED_POLICY_PUBLIC_KEY_KEY, SIGNED_POLICY_REVISION_KEY, SIGNED_POLICY_DIGEST_KEY]);
        verifiedPolicyCache = null;
      }
      await localStore.set({
        ...(parsed.deviceId ? { [LOCAL_DEVICE_ID_KEY]: parsed.deviceId } : {}),
        [LOCAL_POLICY_KEY_ID_KEY]: keyId,
      });
      credential = deviceId ? { token: parsed.token, deviceId } : null;
      reconnectRequired = !credential;
      const localSettings = await localStore.get([DOMAIN_OBSERVATION_KEY]);
      observer.setEnabled(localSettings[DOMAIN_OBSERVATION_KEY] === true && Boolean(deviceId));
      retryAttempt = 0;
      retryAt = 0;
      if (localStore && typeof localStore.set === "function") await localStore.set({ [RETRY_STORAGE_KEY]: null });
      policySyncMessage = "Device connected. Verifying signed owner policy…";
      sendResponse({ ok: true });
      void flushQueue();
      void syncSignedPolicy();
    })().catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === "ENQUEUE_EVENT") {
    if (!isSupportedContentUrl(sender.url)) { sendResponse({ ok: false, queued: false }); return false; }
    void initialize().then(async () => {
      if (!deviceId || !UUID.test(deviceId)) return { queued: false, reason: "RECONNECT_REQUIRED" };
      return queue.enqueue(message.event, deviceId);
    }).then((result) => {
      sendResponse({ ok: result.queued, ...result });
      if (result.queued) void flushQueue();
    }).catch(() => sendResponse({ ok: false, queued: false, reason: "STORAGE_UNAVAILABLE" }));
    return true;
  }

  if (message.type === "ANALYZE_LOCAL") {
    if (!isSupportedContentUrl(sender.url) || typeof message.text !== "string") { sendResponse({ ok: false, error: "UNTRUSTED_ORIGIN" }); return false; }
    void runtimePolicy().then(({ policy, customTerms }) => {
      try { sendResponse({ ok: true, analysis: analyze({ text: message.text, policy, customTerms }) }); }
      catch (error) { sendResponse({ ok: false, error: engineErrorCode(error) }); }
    }).catch(() => sendResponse({ ok: false, error: "ENGINE_FAILURE" }));
    return true;
  }

  if (message.type === "VERIFY_REDACTION") {
    if (!isSupportedContentUrl(sender.url)) { sendResponse({ ok: false }); return false; }
    void runtimePolicy().then(({ policy, customTerms }) => {
      if (typeof message.originalText !== "string" || typeof message.approvedText !== "string" || !message.analysis) throw new Error("invalid");
      const verification = verifyRedaction({
        originalText: message.originalText,
        approvedText: message.approvedText,
        analysis: message.analysis,
        policy,
        customTerms,
        warnAcknowledged: message.warnAcknowledged === true,
      });
      sendResponse({ ok: true, verification });
    }).catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === "TERMINAL_DISPOSITION") {
    sendResponse({ ok: false, queued: false });
    return false;
  }
  return false;
});

alarms.onAlarm.addListener(({ name }) => {
  if (name === POLICY_REFRESH_ALARM) void syncSignedPolicy();
  if (name === BACKOFF_ALARM) {
    retryAt = 0;
    if (localStore && typeof localStore.set === "function") {
      void localStore.set({ [RETRY_STORAGE_KEY]: null }).finally(() => { void flushQueue(); });
    } else void flushQueue();
  }
});

const lifecycle = chrome.runtime as unknown as { onStartup?: { addListener(callback: () => void): void }; onInstalled?: { addListener(callback: () => void): void } };
lifecycle.onStartup?.addListener(() => { void initialize(); });
lifecycle.onInstalled?.addListener(() => { void initialize(); });

function isCoverage(value: unknown): value is Coverage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Coverage;
  return ["SANDBOX_GUARDED", "THIRD_PARTY_BEST_EFFORT", "UNPROTECTED", "UNSUPPORTED"].includes(candidate.mode) && typeof candidate.label === "string" && candidate.label.length <= 160;
}

function isSandboxUrl(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" && url.hostname === "localhost" && url.port === "4173";
  } catch { return false; }
}

function isSupportedContentUrl(raw: unknown): raw is string {
  if (isSandboxUrl(raw)) return true;
  if (typeof raw !== "string") return false;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.port && ["chatgpt.com", "chat.openai.com", "gemini.google.com", "claude.ai"].includes(url.hostname.toLowerCase());
  } catch { return false; }
}

function policyRevision(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value < 2_147_483_647 ? value : 1;
}

function validateCustomTerms(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const output: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") return null;
    const term = raw.trim().normalize("NFC");
    if (term.length < 3 || term.length > 100 || /[\u0000-\u001f\u007f]/u.test(term)) return null;
    const key = term.toLocaleLowerCase("en-US");
    if (seen.has(key)) return null;
    seen.add(key); output.push(term);
  }
  return output;
}

function canonicalJson(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input && typeof input === "object") {
      const object = input as Record<string, unknown>;
      return Object.fromEntries(Object.keys(object).sort().map((key) => [key, sort(object[key])]));
    }
    return input;
  };
  return JSON.stringify(sort(value));
}

function exactProperties(value: unknown, expected: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function decodeBase64(value: unknown, expectedLength: number): Uint8Array<ArrayBuffer> | null {
  if (typeof value !== "string" || value.length > 512 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  try {
    const binary = atob(value);
    if (binary.length !== expectedLength) return null;
    const decoded = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index++) decoded[index] = binary.charCodeAt(index);
    return decoded;
  } catch { return null; }
}

function validUtcTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

async function verifyPolicyBundle(bundle: unknown, keyDocument: unknown, expectedKeyId: string, allowExpired = false): Promise<PolicyConfig | null> {
  try {
    if (!exactProperties(keyDocument, ["algorithm", "keyId", "publicKey"])
      || keyDocument.algorithm !== "ECDSA_P256_SHA256" || keyDocument.keyId !== expectedKeyId) return null;
    if (!exactProperties(bundle, ["algorithm", "keyId", "issuedAt", "expiresAt", "payload", "signature"])
      || bundle.algorithm !== "ECDSA_P256_SHA256" || bundle.keyId !== expectedKeyId
      || !validUtcTimestamp(bundle.issuedAt) || !validUtcTimestamp(bundle.expiresAt)) return null;
    const issuedAt = Date.parse(bundle.issuedAt);
    const expiresAt = Date.parse(bundle.expiresAt);
    const now = Date.now();
    if (issuedAt > now + 5 * 60_000 || (!allowExpired && expiresAt <= now) || expiresAt <= issuedAt || expiresAt - issuedAt > 31 * 24 * 60 * 60_000) return null;

    const rawPublicKey = decodeBase64(keyDocument.publicKey, 65);
    const rawSignature = decodeBase64(bundle.signature, 64);
    if (!rawPublicKey || !rawSignature) return null;
    const digest = await crypto.subtle.digest("SHA-256", rawPublicKey);
    const actualKeyId = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (actualKeyId !== expectedKeyId) return null;

    const verificationKey = await crypto.subtle.importKey("raw", rawPublicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const unsigned = {
      algorithm: bundle.algorithm,
      keyId: bundle.keyId,
      issuedAt: bundle.issuedAt,
      expiresAt: bundle.expiresAt,
      payload: bundle.payload,
    };
    const validSignature = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      verificationKey,
      rawSignature,
      new TextEncoder().encode(canonicalJson(unsigned)),
    );
    if (!validSignature || !bundle.payload || typeof bundle.payload !== "object") return null;
    const policy = bundle.payload as PolicyConfig;
    validatePolicy(policy);
    if (policy.contractVersion !== "v2") return null;
    return policy;
  } catch { return null; }
}

async function getStoredSignedPolicy(): Promise<PolicyConfig | null> {
  try {
    const values = await localStore.get([LOCAL_POLICY_KEY_ID_KEY, SIGNED_POLICY_BUNDLE_KEY, SIGNED_POLICY_PUBLIC_KEY_KEY]);
    const expectedKeyId = values[LOCAL_POLICY_KEY_ID_KEY];
    const bundle = values[SIGNED_POLICY_BUNDLE_KEY];
    const keyDocument = values[SIGNED_POLICY_PUBLIC_KEY_KEY];
    if (typeof expectedKeyId !== "string" || !/^[0-9a-f]{64}$/.test(expectedKeyId) || !bundle || !keyDocument) return null;
    const cacheKey = `${expectedKeyId}|${JSON.stringify(keyDocument)}|${JSON.stringify(bundle)}`;
    if (verifiedPolicyCache?.cacheKey === cacheKey) return verifiedPolicyCache.policy;
    const policy = await verifyPolicyBundle(bundle, keyDocument, expectedKeyId, true);
    if (!policy) return null;
    verifiedPolicyCache = { cacheKey, policy };
    return policy;
  } catch { return null; }
}

async function syncSignedPolicy(trustedKeyIdOverride?: string): Promise<boolean> {
  if (policySyncInProgress) return false;
  policySyncInProgress = true;
  try {
    const activeCredential = await getCredential();
    if (!activeCredential) { policySyncMessage = "Connect this browser with its device credential before syncing policy."; return false; }
    const values = await localStore.get([LOCAL_POLICY_KEY_ID_KEY, SIGNED_POLICY_BUNDLE_KEY, SIGNED_POLICY_PUBLIC_KEY_KEY]);
    const expectedKeyId = trustedKeyIdOverride ?? values[LOCAL_POLICY_KEY_ID_KEY];
    if (typeof expectedKeyId !== "string" || !/^[0-9a-f]{64}$/.test(expectedKeyId)) {
      policySyncMessage = "Enter the fingerprint shown in the owner dashboard before trusting signed policy.";
      return false;
    }
    const apiBase = await getApiBaseURL();
    const headers = { Authorization: `Bearer ${activeCredential.token}`, Accept: "application/json" };
    const options = { method: "GET", cache: "no-store" as RequestCache, credentials: "omit" as RequestCredentials, redirect: "error" as RequestRedirect, headers, signal: AbortSignal.timeout(10_000) };
    const keyResponse = await fetch(`${apiBase}/policy/public-key`, options);
    if (!keyResponse.ok) { policySyncMessage = "Could not retrieve the owner policy verification key."; return false; }
    const keyDocument: unknown = await keyResponse.json();
    if (!exactProperties(keyDocument, ["algorithm", "keyId", "publicKey"]) || keyDocument.keyId !== expectedKeyId) {
      policySyncMessage = "The service policy key does not match the fingerprint approved by the owner.";
      return false;
    }
    const bundleResponse = await fetch(`${apiBase}/policy/bundle`, options);
    if (!bundleResponse.ok) { policySyncMessage = "Could not retrieve the signed owner policy."; return false; }
    const bundle: unknown = await bundleResponse.json();
    const policy = await verifyPolicyBundle(bundle, keyDocument, expectedKeyId);
    if (!policy) { policySyncMessage = "The policy signature, key fingerprint, or expiry is invalid; the previous verified policy remains in force."; return false; }
    const previousValues = await localStore.get([SIGNED_POLICY_REVISION_KEY, SIGNED_POLICY_DIGEST_KEY]);
    const previousRevision = previousValues[SIGNED_POLICY_REVISION_KEY];
    const previousDigest = previousValues[SIGNED_POLICY_DIGEST_KEY];
    const policyDigest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(policy)))), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const previousPolicy = await getStoredSignedPolicy();
    const rollbackRevision = typeof previousRevision === "number" && Number.isSafeInteger(previousRevision) ? previousRevision : previousPolicy?.revision;
    if (rollbackRevision !== undefined && policy.revision < rollbackRevision) {
      policySyncMessage = "An older policy revision was rejected; the previous verified policy remains in force.";
      return false;
    }
    if (rollbackRevision === policy.revision && typeof previousDigest === "string" && previousDigest !== policyDigest) {
      policySyncMessage = "Policy contents changed without a higher revision; the update was rejected.";
      return false;
    }
    if (previousPolicy && policy.revision === previousPolicy.revision && canonicalJson(policy) !== canonicalJson(previousPolicy)) {
      policySyncMessage = "Policy contents changed without a higher revision; the update was rejected.";
      return false;
    }
    await localStore.set({
      [LOCAL_POLICY_KEY_ID_KEY]: expectedKeyId,
      [SIGNED_POLICY_BUNDLE_KEY]: bundle,
      [SIGNED_POLICY_PUBLIC_KEY_KEY]: keyDocument,
      [SIGNED_POLICY_REVISION_KEY]: policy.revision,
      [SIGNED_POLICY_DIGEST_KEY]: policyDigest,
    });
    verifiedPolicyCache = null;
    verifiedPolicyCache = { cacheKey: `${expectedKeyId}|${JSON.stringify(keyDocument)}|${JSON.stringify(bundle)}`, policy };
    policySyncMessage = `Verified owner policy revision ${policy.revision}.`;
    return true;
  } catch {
    policySyncMessage = "Policy synchronization failed. The last verified policy remains active.";
    return false;
  } finally { policySyncInProgress = false; }
}

async function runtimePolicy(): Promise<{ policy: PolicyConfig; customTerms: string[] }> {
  const values = await localStore.get([LOCAL_CUSTOM_TERMS_KEY, LOCAL_POLICY_REVISION_KEY]);
  const customTerms = values[LOCAL_CUSTOM_TERMS_KEY] === undefined ? [] : validateCustomTerms(values[LOCAL_CUSTOM_TERMS_KEY]);
  if (!customTerms) throw new Error("local policy invalid");
  const localRevision = policyRevision(values[LOCAL_POLICY_REVISION_KEY]);
  const signedPolicy = await getStoredSignedPolicy();
  const sourcePolicy = signedPolicy ?? DEFAULT_POLICY;
  const revision = Math.min(2_147_483_647, localRevision + sourcePolicy.revision - 1);
  const policy: PolicyConfig = { ...sourcePolicy, revision };
  validatePolicy(policy);
  return { policy, customTerms };
}

function engineErrorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "ENGINE_FAILURE";
}
