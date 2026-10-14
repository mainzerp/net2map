// Pure, dependency-free search for the command palette.
//
// Ranking tiers (higher wins): exact > IP octet prefix > prefix >
// word-boundary substring > plain substring > subsequence fuzzy. Within a
// tier, shorter candidates rank first. MAC fields ignore the separators
// ":", "-" and "." on both sides, so "aabbcc" matches "aa:bb:cc:dd:ee:ff".

export type MatchRange = [start: number, end: number];

export interface TextMatch {
  score: number;
  ranges: MatchRange[];
}

export const SCORE = {
  exact: 1000,
  ipOctetPrefix: 900,
  prefix: 800,
  wordBoundary: 600,
  substring: 400,
  fuzzy: 250,
} as const;

export type SearchFieldType = "text" | "mac" | "ip";

export interface SearchField {
  text: string | null | undefined;
  type?: SearchFieldType;
  // Multiplier for secondary fields (vendor, notes, ...). Defaults to 1.
  // Secondary fields (weight < 1) skip subsequence fuzzy matching, which
  // would otherwise make long keyword lists match almost anything.
  weight?: number;
}

export type PaletteGroupId = "recent" | "pages" | "actions" | "switches" | "endpoints" | "racks" | "ports";

export interface SearchItem<P = unknown> {
  key: string;
  group: PaletteGroupId;
  label: string;
  detail?: string;
  hint?: string;
  fields: SearchField[];
  payload: P;
  // Only shown when the normalized query contains this text (e.g. "style").
  hiddenUnlessQueryIncludes?: string;
}

export interface SearchHit<P = unknown> {
  item: SearchItem<P>;
  score: number;
  labelRanges: MatchRange[];
}

export interface PaletteGroup<P = unknown> {
  id: PaletteGroupId;
  label: string;
  hits: SearchHit<P>[];
}

export interface PaletteIndex<P = unknown> {
  pages: SearchItem<P>[];
  actions: SearchItem<P>[];
  switches: SearchItem<P>[];
  endpoints: SearchItem<P>[];
  racks: SearchItem<P>[];
  ports: SearchItem<P>[];
}

export const GROUP_LABELS: Record<PaletteGroupId, string> = {
  recent: "Recent",
  pages: "Pages",
  actions: "Actions",
  switches: "Devices",
  endpoints: "Endpoints",
  racks: "Racks",
  ports: "Ports",
};

export const GROUP_ORDER: Exclude<PaletteGroupId, "recent">[] = [
  "pages",
  "actions",
  "switches",
  "endpoints",
  "racks",
  "ports",
];

export const GROUP_CAPS: Record<PaletteGroupId, number> = {
  recent: 5,
  pages: 8,
  actions: 6,
  switches: 6,
  endpoints: 6,
  racks: 6,
  ports: 8,
};

export const OVERALL_CAP = 40;
export const PORT_MIN_QUERY = 2;

const MAC_SEPARATORS = /[:\-.]/g;

export function normalize(text: string): string {
  return text.toLowerCase().trim();
}

export function stripMacSeparators(text: string): string {
  return text.replace(MAC_SEPARATORS, "");
}

function isAlnum(ch: string): boolean {
  return /[a-z0-9]/.test(ch);
}

function lengthPenalty(textLength: number, queryLength: number): number {
  return Math.min(Math.max(textLength - queryLength, 0), 99) * 0.5;
}

function mergeRanges(positions: number[]): MatchRange[] {
  const ranges: MatchRange[] = [];
  for (const pos of positions) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === pos) last[1] = pos + 1;
    else ranges.push([pos, pos + 1]);
  }
  return ranges;
}

function fuzzyMatch(query: string, text: string): TextMatch | null {
  const q = query.replace(/\s+/g, "");
  if (q.length < 2) return null;
  const positions: number[] = [];
  let from = 0;
  for (const ch of q) {
    const idx = text.indexOf(ch, from);
    if (idx < 0) return null;
    positions.push(idx);
    from = idx + 1;
  }
  const span = positions[positions.length - 1] - positions[0] + 1;
  const gaps = span - positions.length;
  const score = SCORE.fuzzy - Math.min(gaps * 4, 100) - lengthPenalty(text.length, q.length) * 0.5;
  return { score, ranges: mergeRanges(positions) };
}

/** Score a normalized query against free text. Returns null on no match. */
export function matchText(query: string, rawText: string, allowFuzzy = true): TextMatch | null {
  const q = normalize(query);
  if (!q || !rawText) return null;
  const text = rawText.toLowerCase();
  const penalty = lengthPenalty(text.length, q.length);

  if (text === q) return { score: SCORE.exact, ranges: [[0, text.length]] };
  if (text.startsWith(q)) return { score: SCORE.prefix - penalty, ranges: [[0, q.length]] };

  let firstIdx = -1;
  for (let idx = text.indexOf(q); idx >= 0; idx = text.indexOf(q, idx + 1)) {
    if (firstIdx < 0) firstIdx = idx;
    if (!isAlnum(text[idx - 1] ?? " ")) {
      return { score: SCORE.wordBoundary - penalty, ranges: [[idx, idx + q.length]] };
    }
  }
  if (firstIdx >= 0) return { score: SCORE.substring - penalty, ranges: [[firstIdx, firstIdx + q.length]] };

  return allowFuzzy ? fuzzyMatch(q, text) : null;
}

/** Separator-insensitive MAC matching. Ranges refer to the original text. */
export function matchMac(query: string, rawText: string): TextMatch | null {
  const q = stripMacSeparators(normalize(query));
  if (!/^[0-9a-f]{2,}$/.test(q) || !rawText) return null;
  const text = rawText.toLowerCase();
  // Map each stripped character back to its index in the original text.
  const indexMap: number[] = [];
  let stripped = "";
  for (let i = 0; i < text.length; i++) {
    if (":-.".includes(text[i])) continue;
    indexMap.push(i);
    stripped += text[i];
  }
  const toRange = (start: number): MatchRange => [indexMap[start], indexMap[start + q.length - 1] + 1];
  const penalty = lengthPenalty(stripped.length, q.length);

  if (stripped === q) return { score: SCORE.exact, ranges: [[0, text.length]] };
  if (stripped.startsWith(q)) return { score: SCORE.prefix - penalty, ranges: [toRange(0)] };
  const idx = stripped.indexOf(q);
  if (idx < 0) return null;
  // An even offset starts on an octet boundary.
  const score = (idx % 2 === 0 ? SCORE.wordBoundary : SCORE.substring) - penalty;
  return { score, ranges: [toRange(idx)] };
}

/** IP matching: a query ending on an octet boundary outranks plain prefixes. */
export function matchIp(query: string, rawText: string, allowFuzzy = true): TextMatch | null {
  const q = normalize(query);
  if (!q || !rawText) return null;
  const text = rawText.toLowerCase();
  if (text !== q && text.startsWith(q) && /^[0-9a-f.:]+$/.test(q)) {
    const next = text[q.length];
    if (q.endsWith(".") || next === "." || next === ":") {
      return { score: SCORE.ipOctetPrefix - lengthPenalty(text.length, q.length), ranges: [[0, q.length]] };
    }
  }
  return matchText(q, text, allowFuzzy);
}

export function matchField(query: string, field: SearchField): TextMatch | null {
  const text = field.text;
  if (!text) return null;
  const allowFuzzy = (field.weight ?? 1) >= 1;
  let best: TextMatch | null;
  if (field.type === "ip") best = matchIp(query, text, allowFuzzy);
  else best = matchText(query, text, allowFuzzy);
  if (field.type === "mac") {
    const mac = matchMac(query, text);
    if (mac && (!best || mac.score > best.score)) best = mac;
  }
  return best;
}

/** Best weighted score of an item over all its fields, or null. */
export function scoreItem(query: string, item: SearchItem): number | null {
  let best: number | null = null;
  for (const field of item.fields) {
    const match = matchField(query, field);
    if (!match) continue;
    const score = match.score * (field.weight ?? 1);
    if (best === null || score > best) best = score;
  }
  return best;
}

export function searchItems<P>(query: string, items: SearchItem<P>[], limit = Infinity): SearchHit<P>[] {
  const q = normalize(query);
  if (!q) return [];
  const hits: SearchHit<P>[] = [];
  for (const item of items) {
    if (item.hiddenUnlessQueryIncludes && !q.includes(item.hiddenUnlessQueryIncludes)) continue;
    const score = scoreItem(q, item);
    if (score === null) continue;
    hits.push({ item, score, labelRanges: matchText(q, item.label)?.ranges ?? [] });
  }
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      a.item.label.length - b.item.label.length ||
      a.item.label.localeCompare(b.item.label),
  );
  return hits.slice(0, limit);
}

/**
 * Group results for the palette. An empty query lists recent targets, pages
 * and actions; otherwise every group is searched (ports only once the query
 * has PORT_MIN_QUERY characters) and capped per group and overall.
 */
export function buildPaletteResults<P>(
  query: string,
  index: PaletteIndex<P>,
  recent: SearchItem<P>[] = [],
): PaletteGroup<P>[] {
  const q = normalize(query);
  const groups: PaletteGroup<P>[] = [];
  let total = 0;
  const push = (id: PaletteGroupId, hits: SearchHit<P>[]) => {
    const room = OVERALL_CAP - total;
    const capped = hits.slice(0, Math.min(GROUP_CAPS[id], room));
    if (capped.length === 0) return;
    total += capped.length;
    groups.push({ id, label: GROUP_LABELS[id], hits: capped });
  };
  const asHits = (items: SearchItem<P>[]) =>
    items
      .filter((item) => !item.hiddenUnlessQueryIncludes)
      .map((item) => ({ item, score: 0, labelRanges: [] as MatchRange[] }));

  if (!q) {
    push("recent", asHits(recent));
    push("pages", asHits(index.pages));
    push("actions", asHits(index.actions));
    return groups;
  }

  for (const id of GROUP_ORDER) {
    if (id === "ports" && q.length < PORT_MIN_QUERY) continue;
    push(id, searchItems(q, index[id], GROUP_CAPS[id]));
  }
  return groups;
}
