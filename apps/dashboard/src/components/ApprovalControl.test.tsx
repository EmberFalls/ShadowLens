// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ApprovalControl } from "./ApprovalControl.js";
import { mockClient } from "../api/mock.js";
import type { DataClient } from "../api/types.js";

afterEach(cleanup);

describe("approval status control", () => {
  it("shows pending and success as informational owner state", async () => {
    let release: ((value: Awaited<ReturnType<DataClient["setApproval"]>>) => void) | undefined;
    const client: DataClient = { ...mockClient, setApproval: () => new Promise((resolve) => { release = resolve; }) };
    const domain = (await mockClient.getDomains())[1];
    render(<ApprovalControl domain={domain} client={client} onUpdated={() => undefined} />);
    fireEvent.change(screen.getByLabelText("Approval"), { target: { value: "APPROVED" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("status").textContent).toBe("Pending");
    release?.({ ...domain, approvalStatus: "APPROVED" });
    expect(await screen.findByText("Saved · informational only")).toBeTruthy();
  });

  it("shows failure without claiming an approval change", async () => {
    const client: DataClient = { ...mockClient, setApproval: async () => { throw new Error("request failed"); } };
    const domain = (await mockClient.getDomains())[1];
    render(<ApprovalControl domain={domain} client={client} onUpdated={() => undefined} />);
    fireEvent.change(screen.getByLabelText("Approval"), { target: { value: "APPROVED" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Could not save")).toBeTruthy();
  });
});
