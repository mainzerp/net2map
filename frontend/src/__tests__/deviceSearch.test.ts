import { describe, it, expect } from "vitest";
import { filterDevices, deviceDisplayName, matchesQuery, DEVICE_PICKER_LIMIT } from "../utils/deviceSearch";

describe("matchesQuery", () => {
  it("needs every token in some field, case-insensitive", () => {
    const fields = ["Core-SW1", "10.0.1.1", null, undefined, "Aruba"];
    expect(matchesQuery("", fields)).toBe(true);
    expect(matchesQuery("  core  ", fields)).toBe(true);
    expect(matchesQuery("aruba 10.0.1", fields)).toBe(true);
    expect(matchesQuery("aruba cisco", fields)).toBe(false);
    expect(matchesQuery("x", [null, ""])).toBe(false);
  });
});

const dev = (id: number, sys_name: string, ip: string, vendor = "", model = "", label?: string) => ({
  id, sys_name, ip, vendor, model, label,
});

const DEVICES = [
  dev(1, "core-sw1", "10.0.1.1", "Aruba", "6300M"),
  dev(2, "edge-sw2", "10.0.2.5", "Cisco", "C9200", "Second floor"),
  dev(3, "", "10.0.1.77", "FS", "S3900"),
  dev(4, "ups-a", "192.168.10.4", "Eaton", "9PX"),
];

describe("filterDevices", () => {
  it("returns all devices sorted by display name for an empty query", () => {
    const { matches, total } = filterDevices(DEVICES, "  ");
    expect(total).toBe(4);
    expect(matches.map((d) => d.id)).toEqual([3, 1, 2, 4]);
  });

  it("matches IP substrings", () => {
    expect(filterDevices(DEVICES, "10.0.1").matches.map((d) => d.id).sort()).toEqual([1, 3]);
    expect(filterDevices(DEVICES, "168.10").matches.map((d) => d.id)).toEqual([4]);
  });

  it("matches name, vendor, model and label case-insensitively", () => {
    expect(filterDevices(DEVICES, "CORE").matches.map((d) => d.id)).toEqual([1]);
    expect(filterDevices(DEVICES, "cisco").matches.map((d) => d.id)).toEqual([2]);
    expect(filterDevices(DEVICES, "s3900").matches.map((d) => d.id)).toEqual([3]);
    expect(filterDevices(DEVICES, "second FLOOR").matches.map((d) => d.id)).toEqual([2]);
  });

  it("requires every whitespace-separated token to match", () => {
    expect(filterDevices(DEVICES, "aruba 10.0.1").matches.map((d) => d.id)).toEqual([1]);
    expect(filterDevices(DEVICES, "aruba 10.0.2").total).toBe(0);
  });

  it("caps the matches but reports the full total", () => {
    const many = Array.from({ length: 120 }, (_, i) => dev(i + 1, `sw-${String(i).padStart(3, "0")}`, `10.1.0.${i}`));
    const res = filterDevices(many, "sw");
    expect(res.total).toBe(120);
    expect(res.matches).toHaveLength(DEVICE_PICKER_LIMIT);
    expect(filterDevices(many, "sw", 5).matches).toHaveLength(5);
  });

  it("falls back to the IP as display name", () => {
    expect(deviceDisplayName(DEVICES[2])).toBe("10.0.1.77");
  });

  it("prefers the reverse DNS name over a sysName that only repeats the IP", () => {
    expect(deviceDisplayName({ ip: "10.0.0.5", sys_name: "10.0.0.5", hostname: "printer.lan" })).toBe("printer.lan");
    expect(deviceDisplayName({ ip: "10.0.0.5", sys_name: "core-sw", hostname: "printer.lan" })).toBe("core-sw");
    expect(deviceDisplayName({ ip: "10.0.0.5", sys_name: "", hostname: "" })).toBe("10.0.0.5");
  });

  it("prefers the display name, then the label, over the scanned names", () => {
    const base = { ip: "10.0.0.5", sys_name: "core-sw", hostname: "core.lan" };
    expect(deviceDisplayName({ ...base, label: "Core RZ", display_name: " Core RZ-01 " })).toBe("Core RZ-01");
    expect(deviceDisplayName({ ...base, label: "Core RZ", display_name: "" })).toBe("Core RZ");
    expect(deviceDisplayName({ ...base, label: "  ", display_name: "" })).toBe("core-sw");
    // A label that only repeats the IP (range discovery without sysName) is skipped.
    expect(deviceDisplayName({ ...base, label: "10.0.0.5" })).toBe("core-sw");
  });
});
