/**
 * Settings page shell: grouped navigation, tab redirects, per-tab create
 * button labels, concept intros, the mobile select navigation, and the
 * command palette entries for every settings tab.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import { renderWithRouter } from "./test-utils";

// The shell is under test, not the tabs: replace each tab with a stub that
// exposes the newEntryTrigger it receives.
function stubTab(name: string) {
  return {
    default: ({ newEntryTrigger }: { newEntryTrigger?: number }) => (
      <div data-testid={`tab-${name}`}>trigger:{newEntryTrigger ?? "none"}</div>
    ),
  };
}

vi.mock("../components/settings/SnmpProfilesTab", () => stubTab("profiles"));
vi.mock("../components/settings/CredentialsTab", () => stubTab("credentials"));
vi.mock("../components/settings/RacksTab", () => stubTab("racks"));
vi.mock("../components/settings/SwitchClassesTab", () => stubTab("classes"));
vi.mock("../components/settings/SwitchModelsTab", () => stubTab("models"));
vi.mock("../components/settings/ScanSettingsTab", () => stubTab("scan"));
vi.mock("../components/settings/DnsTab", () => stubTab("dns"));
vi.mock("../components/settings/BuildingsFloorsTab", () => stubTab("floors"));
vi.mock("../components/settings/ImportExportTab", () => stubTab("import-export"));

import SettingsPage, { SETTINGS_NAV_GROUPS } from "../pages/SettingsPage";
import { SETTINGS_TAB_PAGES, buildPaletteIndex, iconFor } from "../features/command-palette/paletteIndex";
import { buildPaletteResults } from "../features/command-palette/search";

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderSettings(route: string) {
  return renderWithRouter(
    <>
      <Routes>
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/settings/:tab" element={<SettingsPage />} />
      </Routes>
      <LocationProbe />
    </>,
    { route },
  );
}

const location = () => screen.getByTestId("location").textContent;

describe("SettingsPage navigation", () => {
  it("groups tabs in setup order with the landing tab first", () => {
    expect(SETTINGS_NAV_GROUPS.map(g => g.group)).toEqual(["DISCOVERY", "SITE & HARDWARE", "SYSTEM"]);
    expect(SETTINGS_NAV_GROUPS.flatMap(g => g.items.map(i => i.tab))).toEqual([
      "credentials", "profiles", "scan", "dns",
      "floors", "racks", "classes", "models",
      "import-export",
    ]);
  });

  it("redirects /settings and unknown tabs to Network Devices", () => {
    renderSettings("/settings");
    expect(location()).toBe("/settings/credentials");
    expect(screen.getByRole("heading", { name: "Network Devices" })).toBeTruthy();
    expect(screen.getByTestId("tab-credentials")).toBeTruthy();
  });

  it("redirects the legacy map tab to Buildings & Floors", () => {
    renderSettings("/settings/map");
    expect(location()).toBe("/settings/floors");
    expect(screen.getByRole("heading", { name: "Buildings & Floors" })).toBeTruthy();
  });

  it("keeps the /settings/scan deep link working", () => {
    renderSettings("/settings/scan");
    expect(location()).toBe("/settings/scan");
    expect(screen.getByTestId("tab-scan")).toBeTruthy();
    // Scan has no create dialog.
    expect(screen.queryByRole("button", { name: /^New / })).toBeNull();
  });

  it("renders the sidebar with every tab link", () => {
    renderSettings("/settings/credentials");
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    const hrefs = within(nav).getAllByRole("link").map(a => a.getAttribute("href"));
    expect(hrefs).toEqual(SETTINGS_NAV_GROUPS.flatMap(g => g.items.map(i => `/settings/${i.tab}`)));
  });
});

describe("SettingsPage create button", () => {
  it.each([
    ["credentials", "New device"],
    ["profiles", "New profile"],
    ["racks", "New rack"],
    ["classes", "New class"],
    ["models", "New model"],
  ])("labels the create button on %s as %s and bumps the trigger", (tab, label) => {
    renderSettings(`/settings/${tab}`);
    expect(screen.getByTestId(`tab-${tab}`).textContent).toBe("trigger:0");
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(screen.getByTestId(`tab-${tab}`).textContent).toBe("trigger:1");
  });

  it("no longer shows the generic New Entry label", () => {
    renderSettings("/settings/racks");
    expect(screen.queryByText(/New Entry/)).toBeNull();
  });
});

describe("SettingsPage concept intros", () => {
  it.each([
    ["floors", /Buildings contain floors/],
    ["racks", /A rack is a physical cabinet/],
    ["classes", /A class is your own role label/],
    ["models", /A hardware model is a port layout template/],
  ])("explains the %s tab", (tab, text) => {
    renderSettings(`/settings/${tab}`);
    expect(screen.getByText(text)).toBeTruthy();
  });

  it("shows no intro on discovery tabs", () => {
    renderSettings("/settings/credentials");
    expect(screen.queryByText(/A rack is a physical cabinet/)).toBeNull();
    expect(screen.queryByText(/Buildings contain floors/)).toBeNull();
  });
});

describe("SettingsPage mobile select", () => {
  it("groups options and navigates on change", () => {
    renderSettings("/settings/credentials");
    const select = screen.getByLabelText("SETTINGS") as HTMLSelectElement;
    expect(select.value).toBe("credentials");
    const groups = Array.from(select.querySelectorAll("optgroup")).map(g => g.getAttribute("label"));
    expect(groups).toEqual(["DISCOVERY", "SITE & HARDWARE", "SYSTEM"]);

    fireEvent.change(select, { target: { value: "racks" } });
    expect(location()).toBe("/settings/racks");
    expect(screen.getByTestId("tab-racks")).toBeTruthy();
    expect((screen.getByLabelText("SETTINGS") as HTMLSelectElement).value).toBe("racks");
  });
});

describe("command palette settings entries", () => {
  it("indexes every settings tab and keeps the generic settings page", () => {
    const tabs = SETTINGS_NAV_GROUPS.flatMap(g => g.items);
    expect(SETTINGS_TAB_PAGES.map(p => p.to)).toEqual(tabs.map(t => `/settings/${t.tab}`));
    for (const t of tabs) {
      expect(SETTINGS_TAB_PAGES.find(p => p.to === `/settings/${t.tab}`)?.label).toBe(`Settings: ${t.label}`);
    }

    const index = buildPaletteIndex(undefined, undefined);
    const paths = index.pages.map(p => (p.payload.type === "navigate" ? p.payload.to : null));
    expect(paths).toContain("/settings");
    for (const t of tabs) expect(paths).toContain(`/settings/${t.tab}`);

    const racks = index.pages.find(p => p.key === "page:/settings/racks")!;
    expect(racks.hint).toBe("Settings");
    expect(iconFor(racks)).toBe("settings");
  });
});

describe("command palette settings search", () => {
  it("finds settings tabs by old and new names without fuzzy noise", () => {
    const index = buildPaletteIndex(undefined, undefined);
    const pagesFor = (q: string) =>
      buildPaletteResults(q, index).find(g => g.id === "pages")?.hits.map(h => h.item.label) ?? [];

    expect(pagesFor("classes")).toContain("Settings: Device Classes");
    expect(pagesFor("switch models")).toContain("Settings: Hardware Models");
    expect(pagesFor("floors")[0]).toBe("Settings: Buildings & Floors");
    expect(pagesFor("candidates")).toContain("Settings: Network Devices");
    expect(pagesFor("core")).not.toContain("Settings: Backup & Restore");
  });
});
