import domainRegistry from "../../../../packages/contracts/domain-registry.json" with { type: "json" };

export type SiteId = "SANDBOX" | "CHATGPT" | "GEMINI" | "CLAUDE" | "COPILOT" | "PERPLEXITY";
export type SupportStatus = "GUARDED" | "BEST_EFFORT" | "UNSUPPORTED";
export type SiteVisitEvent = {
  contractVersion: "v2";
  eventId: string;
  clientObservedAt: string;
  deviceId: string;
  kind: "SITE_VISIT";
  siteId: SiteId;
  supportStatus: SupportStatus;
  reasonCodes: Array<"UNSUPPORTED_AI_SITE_SEEN">;
};
export type DeviceHeartbeatEvent = {
  contractVersion: "v2";
  eventId: string;
  clientObservedAt: string;
  deviceId: string;
  kind: "DEVICE_HEARTBEAT";
  extensionVersion: string;
};
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
  enqueue: (event: SiteVisitEvent) => void | Promise<unknown>;
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
  private readonly dedupLimit: number;
  private readonly now: () => Date;
  private readonly makeEventId: () => string;

  constructor(private readonly options: DomainObserverOptions) {
    this.enabled = options.enabled;
    this.dedupLimit = Math.max(1, Math.min(options.dedupLimit ?? 2048, 10_000));
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
      if (this.observedDocuments.has(details.documentId)) return false;
      this.observedDocuments.add(details.documentId);
      if (this.observedDocuments.size > this.dedupLimit) {
        const oldest = this.observedDocuments.values().next().value;
        if (oldest !== undefined) this.observedDocuments.delete(oldest);
      }
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
    await this.options.enqueue(event);
    return true;
  }
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
