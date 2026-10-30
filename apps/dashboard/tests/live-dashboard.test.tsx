// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LiveDashboard } from "../src/LiveDashboard.js";
import { mockClient } from "../src/api/mock.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

describe("live dashboard session boundary", () => {
  it("blocks dashboard data while signed out and never falls back to mocks", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/auth/me")
      ? json({ error: { code: "UNAUTHORIZED", message: "auth required" } }, 401)
      : json(await mockClient.getSummary(7)));
    vi.stubGlobal("fetch", fetcher);
    render(<LiveDashboard />);
    expect(await screen.findByRole("heading", { name: "Sign in to ShadowLens" })).toBeTruthy();
    expect(screen.queryByText("MOCK DATA")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("loads live views after owner login and labels the source as live", async () => {
    const summary = await mockClient.getSummary(7);
    let authenticated = false;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://127.0.0.1").pathname;
      if (path.endsWith("/auth/me")) return authenticated ? json({ authenticated: true }) : json({ error: { code: "UNAUTHORIZED" } }, 401);
      if (path.endsWith("/auth/login")) { authenticated = true; return json({ ok: true }); }
      if (path.endsWith("/auth/logout")) { authenticated = false; return json({ ok: true }); }
      if (path.endsWith("/analytics/summary")) return json(summary);
      if (path.endsWith("/analytics/timeseries")) return json(await mockClient.getTimeseries(7, "UTC"));
      if (path.endsWith("/analytics/events")) return json(await mockClient.getEvents(50));
      if (path.endsWith("/domains")) return json(await mockClient.getDomains());
      if (path.endsWith("/devices")) return json(await mockClient.getDevices());
      return json({}, 404);
    });
    vi.stubGlobal("fetch", fetcher);
    render(<LiveDashboard />);
    fireEvent.change(await screen.findByLabelText("Owner password"), { target: { value: "safe-synthetic-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("LIVE DATA")).toBeTruthy();
    expect(await screen.findByText("AI site visits observed")).toBeTruthy();
    expect(fetcher.mock.calls.every(([, init]) => init?.credentials === "include")).toBe(true);
  });
});
