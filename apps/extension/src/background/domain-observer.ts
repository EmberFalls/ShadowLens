import domainRegistry from "../../../../packages/contracts/domain-registry.json" with { type: "json" };
import type { SiteVisit, Heartbeat } from "../../../../packages/contracts/src/generated/event.js";

export type SiteId = "SANDBOX" | "CHATGPT" | "GEMINI" | "CLAUDE" | "COPILOT" | "PERPLEXITY";
export type SupportStatus = "GUARDED" | "BEST_EFFORT" | "UNSUPPORTED";
export type SiteVisitEvent = SiteVisit;
export type DeviceHeartbeatEvent = Heartbeat;
export type ObservationEvent = SiteVisitEvent | DeviceHeartbeatEvent;
export type NavigationCommit = {
  tabId: number;
  frameId: number;
  documentId?: string;
  url: string;
  transitionType: string;
};

type DomainObserverOptions = {
  enabled: boolean;
  getDeviceId: () => string | null;
  enqueue: (event: ObservationEvent) => void | Promise<unknown>;
  now?: () => Date;
  makeEventId?: () => string;
  dedupLimit?: number;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const registrySites = new Map<string, { siteId: SiteId; supportStatus: SupportStatus }>();
for (const site of domainRegistry.sites) {
  for (const host of site.hosts) {
    registrySites.set(host.toLowerCase(), { siteId: site.siteId as SiteId, supportStatus: site.supportStatus as SupportStatus });
  }
}

export class DomainObserver {
  private enabled: boolean;
  private readonly observedDocuments = new Set<string>();
  private readonly pendingDocuments = new Set<string>();
  private readonly dedupLimit: number;
  private readonly now: () => Date;
  private readonly makeEventId: () => string;

  constructor(private readonly options: DomainObserverOptions) {
    this.enabled = options.enabled;
    this.dedupLimit = Number.isFinite(options.dedupLimit) ? Math.max(1, Math.min(Math.floor(options.dedupLimit!), 10_000)) : 2048;
    this.now = options.now ?? (() => new Date());
    this.makeEventId = options.makeEventId ?? (() => crypto.randomUUID());
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.observedDocuments.clear();
  }

  async onCommitted(details: NavigationCommit): Promise<boolean> {
    if (!this.enabled || details.frameId !== 0) return false;
    const site = siteForNavigation(details.url);
    if (!site) return false;
    const deviceId = this.options.getDeviceId();
    if (!deviceId || !UUID_PATTERN.test(deviceId)) return false;

    if (details.documentId) {
      if (this.observedDocuments.has(details.documentId) || this.pendingDocuments.has(details.documentId)) return false;
      this.pendingDocuments.add(details.documentId);
    }

    const event: SiteVisitEvent = {
      contractVersion: "v2",
      eventId: this.makeEventId(),
      clientObservedAt: this.now().toISOString(),
      deviceId,
      kind: "SITE_VISIT",
      siteId: site.siteId,
      supportStatus: site.supportStatus,
      reasonCodes: site.supportStatus === "UNSUPPORTED" ? ["UNSUPPORTED_AI_SITE_SEEN"] : [],
    };
    try {
      const result = await this.options.enqueue(event);
      if (result && typeof result === "object" && "queued" in result && result.queued === false) return false;
      if (details.documentId && this.enabled) {
        this.observedDocuments.add(details.documentId);
        if (this.observedDocuments.size > this.dedupLimit) this.observedDocuments.delete(this.observedDocuments.values().next().value!);
      }
    } finally { if (details.documentId) this.pendingDocuments.delete(details.documentId); }
    return true;
  }
}

/** Browser wiring is injected so SH-009 can compose its single sanitized sink. */
export function installDomainObserver(input: {
  enabled: boolean; getDeviceId: () => string | null; extensionVersion: string;
  enqueue: (event: ObservationEvent) => void | Promise<unknown>;
  navigation: { onCommitted: { addListener(callback: (details: NavigationCommit) => void, filter?: { url: Array<{ hostEquals: string }> }): void; removeListener(callback: (details: NavigationCommit) => void): void } };
  alarms: { create(name: string, options: { periodInMinutes: number }): void; clear(name: string): unknown; onAlarm: { addListener(callback: (alarm: { name: string }) => void): void; removeListener(callback: (alarm: { name: string }) => void): void } };
}): { setEnabled(enabled: boolean): void; dispose(): void } {
  let enabled = input.enabled;
  let disposed = false;
  const observer = new DomainObserver(input);
  const onNavigation = (details: NavigationCommit) => { if (!disposed) void observer.onCommitted(details).catch(() => {}); };
  const heartbeat = () => {
    const deviceId = input.getDeviceId();
    if (disposed || !enabled || !deviceId) return;
    try { void Promise.resolve(input.enqueue(createHeartbeatEvent({ deviceId, extensionVersion: input.extensionVersion }))).catch(() => {}); } catch { /* Missing identity does not create inventory. */ }
  };
  const onAlarm = (alarm: { name: string }) => { if (alarm.name === "shadowlens-heartbeat") heartbeat(); };
  const setEnabled = (value: boolean) => {
    if (disposed) return;
    enabled = value; observer.setEnabled(value);
    if (value) { input.alarms.create("shadowlens-heartbeat", { periodInMinutes: 5 }); heartbeat(); }
    else void input.alarms.clear("shadowlens-heartbeat");
  };
  input.navigation.onCommitted.addListener(onNavigation, { url: [...registrySites.keys()].map(hostEquals => ({ hostEquals })) });
  input.alarms.onAlarm.addListener(onAlarm);
  setEnabled(enabled);
  return { setEnabled, dispose() { if (disposed) return; setEnabled(false); disposed = true; input.navigation.onCommitted.removeListener(onNavigation); input.alarms.onAlarm.removeListener(onAlarm); } };
}

export function siteForNavigation(rawUrl: string): { siteId: SiteId; supportStatus: SupportStatus } | null {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const hostname = url.hostname.toLowerCase();
  const site = registrySites.get(hostname);
  if (!site) return null;
  if (site.siteId === "SANDBOX" && url.origin !== "http://localhost:4173") return null;
  return site;
}

export function createHeartbeatEvent(input: {
  deviceId: string;
  extensionVersion: string;
  now?: Date;
  makeEventId?: () => string;
}): DeviceHeartbeatEvent {
  if (!UUID_PATTERN.test(input.deviceId)) throw new TypeError("Invalid pseudonymous device ID");
  if (!input.extensionVersion || input.extensionVersion.length > 32) throw new TypeError("Invalid extension version");
  return {
    contractVersion: "v2",
    eventId: (input.makeEventId ?? (() => crypto.randomUUID()))(),
    clientObservedAt: (input.now ?? new Date()).toISOString(),
    deviceId: input.deviceId,
    kind: "DEVICE_HEARTBEAT",
    extensionVersion: input.extensionVersion,
  };
}
