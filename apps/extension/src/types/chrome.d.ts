declare namespace chrome {
  namespace runtime {
    const lastError: { message?: string } | undefined;
    function sendMessage(message: unknown, callback: (response: any) => void): void;
    function openOptionsPage(): void;
    function getURL(path: string): string;
    function getManifest(): { version: string };
    const onMessage: { addListener(listener: (message: any, sender: any, sendResponse: (response?: any) => void) => void): void };
  }
  namespace storage {
    namespace local { function get(keys: string[]): Promise<Record<string, unknown>>; function set(items: Record<string, unknown>): Promise<void>; function remove(keys: string[]): Promise<void>; function setAccessLevel(options: { accessLevel: "TRUSTED_CONTEXTS" | "TRUSTED_AND_UNTRUSTED_CONTEXTS" }): Promise<void>; }
    namespace session { function set(items: Record<string, unknown>): Promise<void>; function get(keys: string[]): Promise<Record<string, unknown>>; function remove(keys: string[]): Promise<void>; function setAccessLevel(options: { accessLevel: "TRUSTED_CONTEXTS" | "TRUSTED_AND_UNTRUSTED_CONTEXTS" }): Promise<void>; }
  }
  namespace tabs { function query(query: Record<string, unknown>, callback: (tabs: Array<{ id?: number }>) => void): void; }
  namespace webNavigation {
    type NavigationDetails = { tabId: number; frameId: number; documentId?: string; url: string; transitionType: string };
    const onCommitted: { addListener(listener: (details: NavigationDetails) => void, filter?: { url: Array<{ hostEquals: string }> }): void; removeListener(listener: (details: NavigationDetails) => void): void };
    function addListener(listener: (details: NavigationDetails) => void, filter?: { url: Array<{ hostEquals: string }> }): void;
    function removeListener(listener: (details: NavigationDetails) => void): void;
  }
  namespace alarms { function create(name: string, info: { periodInMinutes: number }): void; function clear(name: string): Promise<boolean>; const onAlarm: { addListener(listener: (alarm: { name: string }) => void): void; removeListener(listener: (alarm: { name: string }) => void): void } }
  namespace runtime { const onStartup: { addListener(listener: () => void): void }; }
  namespace runtime {
    const onInstalled: { addListener(listener: () => void): void };
  }
}
