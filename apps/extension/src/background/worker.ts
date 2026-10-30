import { analyze, verifyRedaction } from "../../../../packages/engine/src/index.js";
import { DEFAULT_POLICY } from "../../../../packages/engine/src/default-policy.js";
import { installDomainObserver, type ObservationEvent } from "./domain-observer.js";
import { API_BASE_URL, EventApiClient, retryDelayMs, type DeviceCredential } from "./api-client.js";
import { PrivacySafeQueue, RETRY_STORAGE_KEY, type StorageArea } from "./queue.js";

type Coverage = { mode: "SANDBOX_GUARDED" | "UNPROTECTED" | "UNSUPPORTED"; label: string };
type ConnectionStatus = { connected: boolean; reconnectRequired: boolean; message: string };
type SessionStore = {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
};
type LocalStore = StorageArea & { get(keys: string[]): Promise<Record<string, unknown>> };
const SESSION_CREDENTIAL_KEY = "deviceCredential";
const LOCAL_DEVICE_ID_KEY = "shadowshieldProvisionedDeviceId";
const DOMAIN_OBSERVATION_KEY = "shadowshieldDomainObservationEnabled";
const BACKOFF_ALARM = "shadowlens-event-flush-backoff";
const SESSION_DEVICE_ID_KEY = "deviceId";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE_TOKEN = /^[A-Za-z0-9_-]{32,512}$/;
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

const apiClient = new EventApiClient(queue, getCredential);

function setAlarm(name: string, delayMs: number): void {
  const alarmApi = chrome.alarms as unknown as { create(name: string, info: { delayInMinutes?: number; periodInMinutes?: number }): void };
  alarmApi.create(name, { delayInMinutes: Math.max(0.5, delayMs / 60_000) });
}

async function flushQueue(): Promise<void> {
  if (Date.now() < retryAt) return;
  if (flushInProgress) return;
  const activeCredential = await getCredential();
  if (!activeCredential) { reconnectRequired = true; connected = false; return; }
  flushInProgress = true;
  try {
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
};
const navEvents = optionalChrome.webNavigation?.onCommitted ?? { addListener: () => {}, removeListener: () => {} };
const alarms = optionalChrome.alarms ?? { create: () => {}, clear: () => false, onAlarm: { addListener: () => {} } };

const observer = installDomainObserver({
  enabled: false,
  getDeviceId: () => deviceId,
  extensionVersion: "0.1.0",
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
      localStore.get([LOCAL_DEVICE_ID_KEY, RETRY_STORAGE_KEY, DOMAIN_OBSERVATION_KEY]),
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
  if (!activeCredential) return { connected: false, reconnectRequired: true, message: "Local API connection is not configured; reconnect with the provisioned device credential." };
  try {
    const response = await fetch(`${API_BASE_URL}/health`, { method: "GET", cache: "no-store", credentials: "omit", redirect: "error" });
    connected = response.ok;
  } catch { connected = false; }
  return {
    connected,
    reconnectRequired,
    message: reconnectRequired ? "Reconnect this browser session with its provisioned device credential." : connected ? "Connected to the local service." : "Local service is unavailable; queued events will retry.",
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  if (message.type === "COVERAGE_UPDATE") {
    if (sender.tab?.id !== undefined && isSandboxUrl(sender.url) && isCoverage(message.coverage)) {
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

  if (message.type === "GET_CONNECTION_STATUS") {
    void readConnectionStatus().then(sendResponse).catch(() => sendResponse({ connected: false, reconnectRequired: true, message: "Local API connection is not configured." }));
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

  if (message.type === "SET_DEVICE_CREDENTIAL") {
    if (sender.url !== chrome.runtime.getURL("options/index.html")) { sendResponse({ ok: false }); return false; }
    const parsed = parseCredential(message);
    if (!parsed) { sendResponse({ ok: false }); return false; }
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
      if (parsed.deviceId) await localStore.set({ [LOCAL_DEVICE_ID_KEY]: parsed.deviceId });
      credential = deviceId ? { token: parsed.token, deviceId } : null;
      reconnectRequired = !credential;
      const localSettings = await localStore.get([DOMAIN_OBSERVATION_KEY]);
      observer.setEnabled(localSettings[DOMAIN_OBSERVATION_KEY] === true && Boolean(deviceId));
      retryAttempt = 0;
      retryAt = 0;
      if (localStore && typeof localStore.set === "function") await localStore.set({ [RETRY_STORAGE_KEY]: null });
      sendResponse({ ok: true });
      void flushQueue();
    })().catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === "ENQUEUE_EVENT") {
    if (!isSandboxUrl(sender.url)) { sendResponse({ ok: false, queued: false }); return false; }
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
    if (!isSandboxUrl(sender.url) || typeof message.text !== "string") { sendResponse({ ok: false, error: "UNTRUSTED_ORIGIN" }); return false; }
    try {
      const analysis = analyze({ text: message.text, policy: DEFAULT_POLICY });
      sendResponse({ ok: true, analysis });
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "ENGINE_FAILURE";
      sendResponse({ ok: false, error: code });
    }
    return false;
  }

  if (message.type === "VERIFY_REDACTION") {
    if (!isSandboxUrl(sender.url)) { sendResponse({ ok: false }); return false; }
    try {
      if (typeof message.originalText !== "string" || typeof message.approvedText !== "string" || !message.analysis) throw new Error("invalid");
      const verification = verifyRedaction({
        originalText: message.originalText,
        approvedText: message.approvedText,
        analysis: message.analysis,
        policy: DEFAULT_POLICY,
        warnAcknowledged: message.warnAcknowledged === true,
      });
      sendResponse({ ok: true, verification });
    } catch {
      sendResponse({ ok: false });
    }
    return false;
  }

  if (message.type === "TERMINAL_DISPOSITION") {
    sendResponse({ ok: false, queued: false });
    return false;
  }
  return false;
});

alarms.onAlarm.addListener(({ name }) => {
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
  return ["SANDBOX_GUARDED", "UNPROTECTED", "UNSUPPORTED"].includes(candidate.mode) && typeof candidate.label === "string" && candidate.label.length <= 100;
}

function isSandboxUrl(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" && url.hostname === "localhost" && url.port === "4173";
  } catch { return false; }
}
