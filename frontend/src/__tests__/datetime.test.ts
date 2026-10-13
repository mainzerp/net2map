/**
 * Tests for shared timestamp parsing and formatting.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_TIMESTAMP_FORMAT, formatTimestamp, parseUtc } from "../utils/datetime";
import { fmtTs } from "../components/settings/scan/format";

const EXPECTED_MS = Date.UTC(2026, 0, 15, 10, 30, 45);

describe("parseUtc", () => {
  it("treats naive ISO strings as UTC", () => {
    expect(parseUtc("2026-01-15T10:30:45").getTime()).toBe(EXPECTED_MS);
  });

  it("treats naive strings with fractional seconds as UTC", () => {
    expect(parseUtc("2026-01-15T10:30:45.000000").getTime()).toBe(EXPECTED_MS);
  });

  it("treats naive strings with a space separator as UTC", () => {
    expect(parseUtc("2026-01-15 10:30:45").getTime()).toBe(EXPECTED_MS);
  });

  it("accepts a trailing Z", () => {
    expect(parseUtc("2026-01-15T10:30:45Z").getTime()).toBe(EXPECTED_MS);
  });

  it("accepts a +00:00 offset", () => {
    expect(parseUtc("2026-01-15T10:30:45.123456+00:00").getTime()).toBe(EXPECTED_MS + 123);
  });

  it("respects non-UTC offsets", () => {
    expect(parseUtc("2026-01-15T12:30:45+02:00").getTime()).toBe(EXPECTED_MS);
  });
});

describe("formatTimestamp", () => {
  const expected = new Date(EXPECTED_MS).toLocaleString(undefined, DEFAULT_TIMESTAMP_FORMAT);

  it("formats naive, Z and offset inputs identically in local time", () => {
    expect(formatTimestamp("2026-01-15T10:30:45")).toBe(expected);
    expect(formatTimestamp("2026-01-15T10:30:45Z")).toBe(expected);
    expect(formatTimestamp("2026-01-15T10:30:45+00:00")).toBe(expected);
  });

  it("supports custom format options", () => {
    const options: Intl.DateTimeFormatOptions = { dateStyle: "short", timeStyle: "medium" };
    expect(formatTimestamp("2026-01-15T10:30:45", options)).toBe(
      new Date(EXPECTED_MS).toLocaleString(undefined, options),
    );
  });

  it("returns a dash for empty input and the raw value for invalid input", () => {
    expect(formatTimestamp(null)).toBe("-");
    expect(formatTimestamp(undefined)).toBe("-");
    expect(formatTimestamp("not-a-date")).toBe("not-a-date");
  });
});

describe("fmtTs", () => {
  it("parses naive strings as UTC", () => {
    expect(fmtTs("2026-01-15T10:30:45")).toBe(new Date(EXPECTED_MS).toLocaleTimeString());
    expect(fmtTs("2026-01-15T10:30:45+00:00")).toBe(new Date(EXPECTED_MS).toLocaleTimeString());
  });
});
