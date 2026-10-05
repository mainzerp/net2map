import { vendorBadge } from "../../theme/visual";

// ── VendorBadge ──────────────────────────────────────────────────────────────
// Small pill naming the device vendor. The vendor color is used for the 1px
// border and a leading dot only (non-text, >= 3:1 against panel in both
// themes); the label itself renders in text-primary because none of the vendor
// mid-tones reach 4.5:1 as text. See VENDOR_BADGE in theme/visual.ts.

interface VendorBadgeProps {
  vendor: string | null | undefined;
  className?: string;
}

export default function VendorBadge({ vendor, className = "" }: VendorBadgeProps) {
  const spec = vendorBadge(vendor);
  return (
    <span
      className={`vendor-badge inline-flex items-center gap-1 shrink-0 rounded-full border bg-panel px-1.5 leading-[14px] text-[9px] font-semibold text-primary whitespace-nowrap ${className}`}
      style={{ borderColor: spec.color }}
      title={spec.name}
      data-vendor={vendor || "generic"}
    >
      <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: spec.color }} aria-hidden="true" />
      {spec.short}
    </span>
  );
}
