// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App.js";
import { mockClient } from "./api/mock.js";
import type { DataClient } from "./api/types.js";

afterEach(cleanup);

describe("dashboard mock experience", () => {
  it("renders empty and partial payloads without inventing counts", async () => {
    const empty: DataClient = {
      getSummary: async () => ({ ...await mockClient.getSummary(7), siteVisitsObserved: 0, guardedAttempts: 0, redactionsPlanned: 0, redactionsPageAttested: 0 }),
      getTimeseries: async (days, timezone) => ({ contractVersion: "v2", windowDays: days, timezone, buckets: [] }),
      getEvents: async () => ({ contractVersion: "v2", items: [], nextCursor: null }),
      getDomains: async () => [], setApproval: mockClient.setApproval, getDevices: async () => ({ contractVersion: "v2", items: [] }),
    };
    render(<App client={empty} />);
    expect(await screen.findByText("No trend data available.")).toBeTruthy();
    expect(screen.getByText("AI site visits observed").nextElementSibling?.textContent).toBe("0");
    expect(screen.getByText("Unregistered devices are not monitored.", { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Events" }));
    expect(screen.getByText("No events available.")).toBeTruthy();
  });

  it("requests and displays the selected timezone", async () => {
    let requestedZone = "";
    const client: DataClient = { ...mockClient, getTimeseries: async (days, timezone) => { requestedZone = timezone; return mockClient.getTimeseries(days, timezone); } };
    render(<App client={client} />);
    await screen.findByText("Trend · visits and guarded attempts");
    fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: "Asia/Kolkata" } });
    await waitFor(() => expect(requestedZone).toBe("Asia/Kolkata"));
    expect(await screen.findByText(/Asia\/Kolkata local dates/)).toBeTruthy();
  });

  it("explains stale devices and preserves NOT_EVALUATED in event rows", async () => {
    render(<App />);
    expect(await screen.findByText(/Stale means not recently observed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Events" }));
    expect(await screen.findByText("NOT_EVALUATED")).toBeTruthy();
  });

  it("shows an unknown API error without exposing response data", async () => {
    const broken = { ...mockClient, getEvents: async () => { throw new Error("private response content"); } } as DataClient;
    render(<App client={broken} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Unknown API error");
    expect(screen.queryByText("private response content")).toBeNull();
  });
});
