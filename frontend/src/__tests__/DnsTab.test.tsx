/**
 * DNS settings tab: the reverse lookup test shows each resolver's answer or error.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { renderWithRouter } from "./test-utils";

const mockApiGet = vi.fn();
const mockApiPost = vi.fn();
const mockApiPut = vi.fn();

vi.mock("../api", () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
    post: (...args: unknown[]) => mockApiPost(...args),
    put: (...args: unknown[]) => mockApiPut(...args),
    invalidate: vi.fn(),
  },
  getStoredUser: () => ({ username: "admin", role: "admin" }),
  extractErrorMessage: (ex: unknown) => (ex instanceof Error ? ex.message : String(ex)),
  API: "",
}));

import DnsSettingsTabContent from "../components/settings/DnsTab";

describe("DnsTab reverse lookup test", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiGet.mockResolvedValue({ servers: ["10.0.0.53"] });
  });

  it("posts the IP and lists the answer of each resolver", async () => {
    mockApiPost.mockResolvedValue({
      ip: "10.0.0.25",
      results: [
        { resolver: "custom", nameservers: ["10.0.0.53"], host: "printer.lan", error: "" },
        { resolver: "system", nameservers: ["127.0.0.11"], host: "", error: "herror: Unknown host" },
      ],
    });
    renderWithRouter(<DnsSettingsTabContent />);
    fireEvent.change(screen.getByLabelText("IP address to resolve"), { target: { value: " 10.0.0.25 " } });
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));

    await waitFor(() => expect(mockApiPost).toHaveBeenCalledWith("/api/dns-settings/test", { ip: "10.0.0.25" }));
    const results = await screen.findByTestId("dns-test-results");
    expect(results.textContent).toContain("printer.lan");
    expect(results.textContent).toContain("herror: Unknown host");
    expect(results.textContent).toContain("127.0.0.11");
  });

  it("keeps the button disabled without an IP", async () => {
    renderWithRouter(<DnsSettingsTabContent />);
    expect((screen.getByRole("button", { name: "Resolve" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
