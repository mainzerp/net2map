import { useEffect, useState, type ReactNode } from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "../theme/ThemeProvider";
import { useToast, type ToastType } from "../components/ToastProvider";
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Input,
  Select,
  Sparkline,
  Spinner,
  StatusDot,
  type BadgeTone,
  type DataTableColumn,
} from "../components/ui";
import { CABLE_COLORS, VENDOR_COLOR, VENDOR_LABEL, speedColor, speedLabel } from "../theme/visual";
import { vlanColor } from "../features/topology/vlanColor";

// Design-system review page ("Cartography"). Reachable at /styleguide behind
// the normal auth shell; intentionally not linked from the navigation.

const TOKEN_GROUPS: { title: string; tokens: string[] }[] = [
  { title: "Surfaces and lines", tokens: ["surface", "panel", "panel-2", "line", "line-strong"] },
  { title: "Text", tokens: ["primary", "muted"] },
  { title: "Accent", tokens: ["accent", "accent-strong", "accent-soft", "accent-contrast"] },
  {
    title: "Status",
    tokens: ["success", "success-soft", "warning", "warning-soft", "danger", "danger-soft"],
  },
  { title: "Data and highlight", tokens: ["external", "port-highlight", "scrim"] },
  { title: "Sidebar", tokens: ["sidebar", "sidebar-hover", "sidebar-muted", "sidebar-text"] },
];

const SHADOW_TOKENS = ["shadow-card", "shadow-raised"];
const RADIUS_TOKENS = ["radius-control", "radius-card"];

const SPARKLINE_DEMOS: {
  tone: "ok" | "warning" | "danger" | "neutral";
  values: (number | null)[];
  baseline?: number;
}[] = [
  { tone: "ok", values: [1.2, 1.1, 1.4, 1.3, 1.2, 1.5, 1.3, 1.2, 1.1, 1.3], baseline: 1.3 },
  { tone: "warning", values: [2, 2.4, 3.1, null, null, 4.2, 5.1, 4.8, 6, 5.5], baseline: 2.2 },
  { tone: "danger", values: [3, 4, 8, 12, 9, null, 15, 18, null, 20] },
  { tone: "neutral", values: [5, 7, 6, 8, 7, 9, 8, 10, 9, 11] },
];

// Reads the resolved value of a CSS custom property; re-run on theme change.
function useCssVars(names: string[], theme: string): Record<string, string> {
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    const style = getComputedStyle(document.documentElement);
    const next: Record<string, string> = {};
    names.forEach((n) => {
      next[n] = style.getPropertyValue(`--${n}`).trim();
    });
    setValues(next);
    // names is a module-level constant list per call site
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);
  return values;
}

function Section({ title, children, hint }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold text-primary m-0">{title}</h2>
        {hint && <p className="text-[11px] text-muted m-0 mt-0.5">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Swatch({ name, value }: { name: string; value: string }) {
  return (
    <div className="flex items-center gap-3 min-w-0">
      <span
        className="w-10 h-10 shrink-0 rounded-control border border-line"
        style={{ background: `var(--${name})` }}
        aria-hidden="true"
      />
      <div className="min-w-0">
        <div className="text-xs font-semibold text-primary truncate">{name}</div>
        <div className="text-[11px] text-muted font-mono">{value || "-"}</div>
      </div>
    </div>
  );
}

interface SampleRow {
  id: number;
  name: string;
  ip: string;
  ports: number;
  status: "up" | "down" | "unknown";
}

const SAMPLE_ROWS: SampleRow[] = [
  { id: 1, name: "core-sw-01", ip: "10.0.0.1", ports: 48, status: "up" },
  { id: 2, name: "access-sw-02", ip: "10.0.0.12", ports: 24, status: "up" },
  { id: 3, name: "edge-fw-01", ip: "10.0.0.254", ports: 8, status: "down" },
  { id: 4, name: "lab-sw-07", ip: "10.0.3.7", ports: 16, status: "unknown" },
];

const STATUS_WORD: Record<SampleRow["status"], string> = { up: "Online", down: "Offline", unknown: "Unknown" };

const SAMPLE_COLUMNS: DataTableColumn<SampleRow>[] = [
  { key: "name", header: "Device", sortable: true, render: (r) => <span className="font-semibold">{r.name}</span> },
  { key: "ip", header: "IP", sortable: true, render: (r) => <span className="font-mono text-muted">{r.ip}</span> },
  { key: "ports", header: "Ports", sortable: true, align: "right", render: (r) => <span className="tabular-nums">{r.ports}</span> },
  {
    key: "status",
    header: "Status",
    render: (r) => (
      <span className="inline-flex items-center gap-1.5">
        <StatusDot status={r.status} />
        {STATUS_WORD[r.status]}
      </span>
    ),
  },
];

const BADGE_TONES: BadgeTone[] = ["neutral", "accent", "success", "warning", "danger"];
const TOAST_TYPES: ToastType[] = ["success", "error", "warning", "info"];
const SPEEDS = [100, 1000, 10000, 25000, 100000];
const VLAN_SAMPLE_IDS = [1, 10, 20, 30, 40, 99, 100, 200];

export default function StyleguidePage() {
  const { theme, toggleTheme } = useTheme();
  const { addToast } = useToast();
  const allTokens = TOKEN_GROUPS.flatMap((g) => g.tokens);
  const values = useCssVars([...allTokens, ...SHADOW_TOKENS, ...RADIUS_TOKENS], theme);
  const [inputValue, setInputValue] = useState("");

  return (
    <div className="max-w-5xl mx-auto flex flex-col gap-10 pb-16">
      <header className="flex items-end justify-between gap-4 flex-wrap pt-4">
        <div>
          <div className="eyebrow">Design system</div>
          <h1 className="text-2xl font-semibold text-primary m-0 mt-1 tracking-tight">Cartography styleguide</h1>
          <p className="text-xs text-muted m-0 mt-1">
            Warm paper neutrals, ink-navy chrome and one terracotta accent. Current theme:{" "}
            <span className="font-semibold text-primary">{theme}</span>.
          </p>
        </div>
        <Button onClick={toggleTheme}>
          {theme === "dark" ? <Sun size={14} aria-hidden="true" /> : <Moon size={14} aria-hidden="true" />}
          Switch to {theme === "dark" ? "light" : "dark"} theme
        </Button>
      </header>

      <Section title="Color tokens" hint="CSS custom properties from src/index.css, resolved for the current theme.">
        <div className="flex flex-col gap-6">
          {TOKEN_GROUPS.map((group) => (
            <div key={group.title}>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-2">{group.title}</div>
              <div className="grid gap-3 grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
                {group.tokens.map((t) => (
                  <Swatch key={t} name={t} value={values[t] ?? ""} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Radius and elevation">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="bg-panel border border-line rounded-card shadow-card p-4">
            <div className="text-xs font-semibold">shadow-card / rounded-card</div>
            <div className="text-[11px] text-muted font-mono mt-1">
              {values["shadow-card"]} / {values["radius-card"]}
            </div>
          </div>
          <div className="bg-panel border border-line rounded-card shadow-raised p-4">
            <div className="text-xs font-semibold">shadow-raised</div>
            <div className="text-[11px] text-muted font-mono mt-1">{values["shadow-raised"]}</div>
          </div>
        </div>
      </Section>

      <Section title="Data palette" hint="theme/visual.ts: cable colors, speed tiers and vendor colors.">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            {CABLE_COLORS.map((c) => (
              <span key={c} className="inline-flex items-center gap-1.5 text-[11px] text-muted font-mono">
                <span className="w-6 h-2 rounded-full" style={{ background: c }} aria-hidden="true" />
                {c}
              </span>
            ))}
          </div>
          <div className="flex flex-wrap gap-4">
            {SPEEDS.map((s) => (
              <span key={s} className="inline-flex items-center gap-1.5 text-xs">
                <span className="w-6 h-2 rounded-full" style={{ background: speedColor(s) }} aria-hidden="true" />
                {speedLabel(s)}
              </span>
            ))}
          </div>
          <div className="flex flex-wrap gap-4">
            {Object.entries(VENDOR_COLOR).map(([v, c]) => (
              <span key={v} className="inline-flex items-center gap-1.5 text-xs" style={{ color: c }}>
                <span className="w-2 h-2 rounded-full" style={{ background: c }} aria-hidden="true" />
                {VENDOR_LABEL[v] ?? v}
              </span>
            ))}
          </div>
        </div>
      </Section>

      <Section
        title="Map layers"
        hint="features/topology/vlanColor.ts: one stable hue per VLAN id (terracotta/red band excluded); STP uses overlay-stp."
      >
        <div className="flex flex-wrap gap-3" data-testid="vlan-palette">
          {VLAN_SAMPLE_IDS.map((id) => {
            const c = vlanColor(id);
            return (
              <span key={id} className="inline-flex items-center gap-1.5 text-xs">
                <span className="w-6 h-2 rounded-full" style={{ background: c.stroke }} aria-hidden="true" />
                <span
                  className="rounded-full border px-1.5 font-mono font-semibold text-[10px] tabular-nums"
                  style={{ borderColor: c.stroke, backgroundColor: c.soft, color: c.stroke }}
                >
                  {id}
                </span>
              </span>
            );
          })}
          <span className="inline-flex items-center gap-1.5 text-xs text-muted">
            <span className="w-6 h-2 rounded-full bg-overlay-stp" aria-hidden="true" />
            STP
          </span>
        </div>
      </Section>

      <Section title="Typography" hint="System font stack; mono stack for IPs and MACs; tabular numbers.">
        <Card>
          <div className="flex flex-col gap-3">
            <div className="eyebrow">Eyebrow label</div>
            <div className="text-2xl font-semibold tracking-tight">All 23 switches online.</div>
            <div className="text-lg font-semibold">Section heading</div>
            <div className="text-sm">Body text at 14px for longer reading.</div>
            <div className="text-xs">Dense UI text at 12px (app default).</div>
            <div className="text-[11px] text-muted">Secondary text at 11px in muted.</div>
            <div className="font-mono text-xs">10.0.0.254 &middot; 00:1a:2b:3c:4d:5e &middot; ge-0/0/12</div>
            <div className="tabular-nums text-xs">
              1,204 &middot; 88 &middot; 12,345 (tabular-nums)
            </div>
          </div>
        </Card>
      </Section>

      <Section title="Buttons">
        <Card>
          <div className="flex flex-col gap-4">
            {(["md", "sm"] as const).map((size) => (
              <div key={size} className="flex flex-wrap items-center gap-2">
                <span className="w-8 text-[11px] text-muted font-mono">{size}</span>
                <Button size={size} variant="primary">Primary</Button>
                <Button size={size} variant="secondary">Secondary</Button>
                <Button size={size} variant="danger">Danger</Button>
                <Button size={size} variant="ghost">Ghost</Button>
                <Button size={size} variant="primary" disabled>Disabled</Button>
              </div>
            ))}
          </div>
        </Card>
      </Section>

      <Section title="Badges and status">
        <Card>
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              {BADGE_TONES.map((t) => (
                <Badge key={t} tone={t}>{t}</Badge>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-5 text-xs">
              <span className="inline-flex items-center gap-2"><StatusDot status="up" /> Online</span>
              <span className="inline-flex items-center gap-2"><StatusDot status="down" /> Offline</span>
              <span className="inline-flex items-center gap-2"><StatusDot status="unknown" /> Unknown</span>
              <span className="inline-flex items-center gap-2"><Spinner size={14} /> Loading</span>
            </div>
          </div>
        </Card>
      </Section>

      <Section title="Form controls">
        <Card>
          <div className="grid gap-4 md:grid-cols-3">
            <label className="flex flex-col gap-1 text-[11px] text-muted">
              Input
              <Input placeholder="Hostname or IP" value={inputValue} onChange={(e) => setInputValue(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-muted">
              Invalid input
              <Input invalid defaultValue="10.0.0.300" />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-muted">
              Select
              <Select defaultValue="aruba_cx">
                {Object.entries(VENDOR_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </Select>
            </label>
          </div>
        </Card>
      </Section>

      <Section title="Card">
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Card with title" actions={<Button size="sm" variant="ghost">Action</Button>}>
            <p className="text-xs text-muted m-0">Cards use radius-card and shadow-card with a 1px warm line.</p>
          </Card>
          <Card>
            <EmptyState title="Nothing to show" hint="Empty state inside a card." />
          </Card>
        </div>
      </Section>

      <Section title="Sparkline" hint="Inline SVG trend line; null values render as gaps, optional dashed baseline.">
        <div className="grid gap-4 md:grid-cols-2">
          {SPARKLINE_DEMOS.map((demo) => (
            <Card key={demo.tone}>
              <div className="text-[11px] text-muted mb-2">
                tone=&quot;{demo.tone}&quot;{demo.baseline != null ? `, baseline ${demo.baseline}` : ""}
              </div>
              <Sparkline
                values={demo.values}
                tone={demo.tone}
                area
                baseline={demo.baseline}
                height={40}
                ariaLabel={`Sample ${demo.tone} sparkline`}
              />
            </Card>
          ))}
        </div>
      </Section>

      <Section title="Data table">
        <DataTable
          columns={SAMPLE_COLUMNS}
          rows={SAMPLE_ROWS}
          rowKey={(r) => r.id}
          searchable
          searchText={(r) => `${r.name} ${r.ip}`}
          paginated={false}
        />
      </Section>

      <Section title="Toasts">
        <div className="flex flex-wrap gap-2">
          {TOAST_TYPES.map((t) => (
            <Button key={t} size="sm" onClick={() => addToast(`Sample ${t} toast message`, t)}>
              Show {t}
            </Button>
          ))}
        </div>
      </Section>
    </div>
  );
}
