import { describe, expect, it } from "vitest";
import { migrateLegacyStorageKeys } from "../storageMigration";

function memoryStorage(initial: Record<string, string>): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => Array.from(data.keys())[index] ?? null,
    removeItem: (key) => { data.delete(key); },
    setItem: (key, value) => { data.set(key, String(value)); },
  };
}

describe("migrateLegacyStorageKeys", () => {
  it("copies legacy NetMap keys to the Net2Map keys and removes them", () => {
    const storage = memoryStorage({ "netmap-theme": "dark", "netmap.palette.recent": '["device:1"]' });

    migrateLegacyStorageKeys(storage);

    expect(storage.getItem("net2map-theme")).toBe("dark");
    expect(storage.getItem("net2map.palette.recent")).toBe('["device:1"]');
    expect(storage.getItem("netmap-theme")).toBeNull();
    expect(storage.getItem("netmap.palette.recent")).toBeNull();
  });

  it("never overwrites a value already stored under the new key", () => {
    const storage = memoryStorage({ "netmap-theme": "dark", "net2map-theme": "light" });

    migrateLegacyStorageKeys(storage);

    expect(storage.getItem("net2map-theme")).toBe("light");
    expect(storage.getItem("netmap-theme")).toBeNull();
  });

  it("migrates the persisted floor choice", () => {
    const storage = memoryStorage({ "netmap-floor": "b1:f2" });

    migrateLegacyStorageKeys(storage);

    expect(storage.getItem("net2map-floor")).toBe("b1:f2");
    expect(storage.getItem("netmap-floor")).toBeNull();
  });

  it("migrates prefixed per-floor zoom keys and keeps the suffix", () => {
    const storage = memoryStorage({
      "netmap-zoom:b1:f2": '{"x":1}',
      "netmap-zoom:none": '{"x":2}',
      "net2map-zoom:none": '{"x":3}',
    });

    migrateLegacyStorageKeys(storage);

    expect(storage.getItem("net2map-zoom:b1:f2")).toBe('{"x":1}');
    expect(storage.getItem("net2map-zoom:none")).toBe('{"x":3}');
    expect(storage.getItem("netmap-zoom:b1:f2")).toBeNull();
    expect(storage.getItem("netmap-zoom:none")).toBeNull();
  });
});
