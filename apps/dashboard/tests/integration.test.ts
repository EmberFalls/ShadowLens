import { describe, expect, it, vi } from "vitest";
import { mockClient } from "../src/api/mock.js";
import { ApiError, createApiClient } from "../src/api/client.js";

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "X-Request-ID": "test-request" } });
}

describe("live dashboard API client", () => {
  it("uses owner cookies, typed routes, timezone, cursor, and approval updates", async () => {
    const domains = await mockClient.getDomains();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://127.0.0.1:8787");
      if (url.pathname.endsWith("/auth/me")) return response({ authenticated: true });
      if (url.pathname.endsWith("/analytics/summary")) return response(await mockClient.getSummary(14));
      if (url.pathname.endsWith("/analytics/timeseries")) return response(await mockClient.getTimeseries(7, "Asia/Kolkata"));
      if (url.pathname.endsWith("/analytics/events")) return response(await mockClient.getEvents(20));
      if (url.pathname.endsWith("/domains/CHATGPT/approval")) return response({ ...domains[1], approvalStatus: "APPROVED" });
      if (url.pathname.endsWith("/domains")) return response(domains);
      if (url.pathname.endsWith("/devices")) return response(await mockClient.getDevices());
      if (url.pathname.endsWith("/auth/login") || url.pathname.endsWith("/auth/logout")) return response({ ok: true });
      throw new Error(`Unexpected route ${url.pathname} ${init?.method}`);
    });
    const client = createApiClient({ baseUrl: "http://127.0.0.1:8787", fetchImpl });
    expect((await client.getSummary(14)).windowDays).toBe(14);
    expect((await client.getTimeseries(7, "Asia/Kolkata")).timezone).toBe("Asia/Kolkata");
    expect((await client.getEvents(20, "cursor +/")).items).toHaveLength(3);
    expect((await client.getDomains())[1].siteId).toBe("CHATGPT");
    expect((await client.setApproval("CHATGPT", "APPROVED")).approvalStatus).toBe("APPROVED");
    expect((await client.getDevices()).items).toHaveLength(3);
    expect(await client.getCurrentSession()).toBe(true);
    await client.login("correct horse battery staple"); await client.logout();

    const requests = fetchImpl.mock.calls.map(([input, init]) => ({ url: new URL(String(input)), init }));
    expect(requests.every(({ init }) => init?.credentials === "include" && init.cache === "no-store")).toBe(true);
    expect(requests.find(({ url }) => url.pathname.endsWith("/analytics/timeseries"))?.url.searchParams.get("tz")).toBe("Asia/Kolkata");
    expect(requests.find(({ url }) => url.pathname.endsWith("/analytics/events"))?.url.searchParams.get("cursor")).toBe("cursor +/");
    const approval = requests.find(({ url }) => url.pathname.endsWith("/domains/CHATGPT/approval"));
    expect(approval?.init?.method).toBe("PUT");
    expect(JSON.parse(String(approval?.init?.body))).toEqual({ approvalStatus: "APPROVED" });
    expect(requests.find(({ url }) => url.pathname.endsWith("/auth/login"))?.init?.method).toBe("POST");
    expect(requests.find(({ url }) => url.pathname.endsWith("/auth/logout"))?.init?.method).toBe("POST");
  });

  it("notifies the shell on 401 and uses safe typed errors for failures", async () => {
    const expired = vi.fn(async () => response({ error: { code: "UNAUTHORIZED", message: "auth required" } }, 401));
    const onUnauthorized = vi.fn();
    const client = createApiClient({ fetchImpl: expired as typeof fetch, onUnauthorized });
    await expect(client.getCurrentSession()).rejects.toMatchObject<ApiError>({ status: 401, code: "UNAUTHORIZED" });
    expect(onUnauthorized).toHaveBeenCalledOnce();

    const unavailable = createApiClient({ fetchImpl: vi.fn(async () => response({ error: { message: "private server detail" } }, 503)) as typeof fetch });
    await expect(unavailable.getSummary(7)).rejects.toMatchObject<ApiError>({ status: 503, code: "UNAVAILABLE", message: "The local service is temporarily unavailable." });

    const invalid = createApiClient({ fetchImpl: vi.fn(async () => response({ contractVersion: "v2", windowDays: 7, timezone: "UTC" })) as typeof fetch });
    await expect(invalid.getSummary(7)).rejects.toMatchObject<ApiError>({ status: 502, code: "INVALID_RESPONSE" });

    const inconsistent = createApiClient({ fetchImpl: vi.fn(async () => response(await mockClient.getSummary(14))) as typeof fetch });
    await expect(inconsistent.getSummary(7)).rejects.toMatchObject<ApiError>({ status: 502, code: "INVALID_RESPONSE" });
  });

  it("rejects payloads with raw prompt or URL fields instead of rendering them", async () => {
    const unsafe = await mockClient.getEvents(50);
    const first = unsafe.items[0] as unknown as { event: Record<string, unknown>; ingestedAt: string };
    for (const extra of [{ promptText: "should never render" }, { content: "unrecognized private data" }]) {
      const client = createApiClient({ fetchImpl: vi.fn(async () => response({ ...unsafe, items: [{ ...first, event: { ...first.event, ...extra } }] })) as typeof fetch });
      await expect(client.getEvents(50)).rejects.toMatchObject<ApiError>({ status: 502, code: "INVALID_RESPONSE" });
    }
  });
});
