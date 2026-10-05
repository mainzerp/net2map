/**
 * Unit tests for the pure command palette search module.
 */
import { describe, it, expect } from "vitest";
import {
  GROUP_CAPS,
  OVERALL_CAP,
  SCORE,
  buildPaletteResults,
  matchIp,
  matchMac,
  matchText,
  searchItems,
  type PaletteIndex,
  type SearchItem,
} from "../features/command-palette/search";

function item(key: string, label: string, fields: SearchItem["fields"], group: SearchItem["group"] = "switches"): SearchItem {
  return { key, group, label, fields, payload: key };
}

function emptyIndex(): PaletteIndex {
  return { pages: [], actions: [], switches: [], endpoints: [], racks: [], ports: [] };
}

describe("matchMac", () => {
  it("matches regardless of separators in the candidate", () => {
    expect(matchMac("aabbcc", "aa:bb:cc:dd:ee:ff")).not.toBeNull();
    expect(matchMac("aabbcc", "aa-bb-cc-dd-ee-ff")).not.toBeNull();
    expect(matchMac("aabbcc", "aabb.ccdd.eeff")).not.toBeNull();
  });

  it("matches regardless of separators in the query", () => {
    expect(matchMac("aa-bb:cc", "aabb.ccdd.eeff")).not.toBeNull();
  });

  it("maps the highlight range back onto the original text", () => {
    const match = matchMac("bbcc", "aa:bb:cc:dd:ee:ff");
    expect(match?.ranges).toEqual([[3, 8]]);
  });

  it("rejects non-hex queries and non-matching MACs", () => {
    expect(matchMac("zz", "aa:bb:cc:dd:ee:ff")).toBeNull();
    expect(matchMac("aabbdd", "aa:bb:cc:dd:ee:ff")).toBeNull();
  });
});

describe("matchIp", () => {
  it("ranks an octet-aligned prefix above a partial-octet prefix", () => {
    const aligned = matchIp("10.0.1", "10.0.1.5");
    const partial = matchIp("10.0.1", "10.0.10.5");
    expect(aligned).not.toBeNull();
    expect(partial).not.toBeNull();
    expect(aligned!.score).toBeGreaterThan(partial!.score);
    expect(aligned!.score).toBeGreaterThanOrEqual(SCORE.ipOctetPrefix - 50);
  });

  it("accepts a trailing dot", () => {
    expect(matchIp("10.0.1.", "10.0.1.200")?.ranges).toEqual([[0, 7]]);
  });

  it("does not match other subnets", () => {
    expect(matchIp("10.0.2", "10.0.1.5")).toBeNull();
  });
});

describe("matchText ranking tiers", () => {
  it("orders exact > prefix > word boundary > substring > fuzzy", () => {
    const exact = matchText("core", "core")!.score;
    const prefix = matchText("core", "core-sw1")!.score;
    const boundary = matchText("core", "dc1-core-sw1")!.score;
    const substring = matchText("core", "hardcore")!.score;
    const fuzzy = matchText("core", "c-o-r-e")!.score;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(boundary);
    expect(boundary).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(fuzzy);
  });

  it("returns subsequence ranges for fuzzy matches", () => {
    expect(matchText("cs1", "core-sw1")?.ranges).toEqual([
      [0, 1],
      [5, 6],
      [7, 8],
    ]);
  });

  it("returns null when characters are missing", () => {
    expect(matchText("xyz", "core-sw1")).toBeNull();
  });
});

describe("searchItems", () => {
  it("ranks exact over prefix over fuzzy matches", () => {
    const items = [
      item("fuzzy", "a-c-c-e-s-s", [{ text: "a-c-c-e-s-s" }]),
      item("prefix", "access-sw2", [{ text: "access-sw2" }]),
      item("exact", "access", [{ text: "access" }]),
    ];
    expect(searchItems("access", items).map((h) => h.item.key)).toEqual(["exact", "prefix", "fuzzy"]);
  });

  it("finds a switch by separator-free MAC and by IP prefix", () => {
    const sw = item("sw", "core-sw1", [
      { text: "core-sw1" },
      { text: "10.0.1.5", type: "ip" },
      { text: "00:1a:2b:3c:4d:5e", type: "mac" },
    ]);
    expect(searchItems("001a2b", [sw])).toHaveLength(1);
    expect(searchItems("10.0.1", [sw])).toHaveLength(1);
  });

  it("skips items hidden unless the query mentions them", () => {
    const hidden = { ...item("style", "Styleguide", [{ text: "Styleguide" }], "pages"), hiddenUnlessQueryIncludes: "style" };
    expect(searchItems("guide", [hidden])).toHaveLength(0);
    expect(searchItems("style", [hidden])).toHaveLength(1);
  });
});

describe("buildPaletteResults", () => {
  it("caps each group and the overall result count", () => {
    const index = emptyIndex();
    for (let i = 0; i < 30; i++) {
      index.switches.push(item(`sw${i}`, `sw-${i}`, [{ text: `sw-${i}` }]));
      index.endpoints.push(item(`ep${i}`, `sw-host-${i}`, [{ text: `sw-host-${i}` }], "endpoints"));
      index.racks.push(item(`rk${i}`, `sw-rack-${i}`, [{ text: `sw-rack-${i}` }], "racks"));
      index.ports.push(item(`pt${i}`, `sw-${i} ge-0/0/${i}`, [{ text: `sw-${i} ge-0/0/${i}` }], "ports"));
    }
    const groups = buildPaletteResults("sw", index);
    const byId = Object.fromEntries(groups.map((g) => [g.id, g.hits.length]));
    expect(byId.switches).toBe(GROUP_CAPS.switches);
    expect(byId.endpoints).toBe(GROUP_CAPS.endpoints);
    expect(byId.racks).toBe(GROUP_CAPS.racks);
    expect(byId.ports).toBe(GROUP_CAPS.ports);
    const total = groups.reduce((n, g) => n + g.hits.length, 0);
    expect(total).toBeLessThanOrEqual(OVERALL_CAP);
  });

  it("only searches ports once the query has two characters", () => {
    const index = emptyIndex();
    index.ports.push(item("pt", "core g1", [{ text: "core g1" }], "ports"));
    expect(buildPaletteResults("g", index).find((g) => g.id === "ports")).toBeUndefined();
    expect(buildPaletteResults("g1", index).find((g) => g.id === "ports")?.hits).toHaveLength(1);
  });

  it("shows recent, pages and actions for an empty query", () => {
    const index = emptyIndex();
    index.pages.push(item("page", "Dashboard", [{ text: "Dashboard" }], "pages"));
    index.pages.push({ ...item("style", "Styleguide", [{ text: "Styleguide" }], "pages"), hiddenUnlessQueryIncludes: "style" });
    index.actions.push(item("scan", "Start scan", [{ text: "Start scan" }], "actions"));
    index.switches.push(item("sw", "core", [{ text: "core" }]));
    const recent = [item("recent:sw", "core", [{ text: "core" }], "recent")];
    const groups = buildPaletteResults("", index, recent);
    expect(groups.map((g) => g.id)).toEqual(["recent", "pages", "actions"]);
    expect(groups[1].hits.map((h) => h.item.key)).toEqual(["page"]);
  });
});
