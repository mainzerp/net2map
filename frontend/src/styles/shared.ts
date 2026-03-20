/**
 * Shared style objects for common UI patterns.
 */
import type React from "react";
import { colors, radii, fonts, spacing } from "./tokens";

export const cardStyle: React.CSSProperties = {
  backgroundColor: colors.bg.card,
  border: `1px solid ${colors.border.default}`,
  borderRadius: radii.xl,
};

export const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "7px 10px",
  background: colors.bg.base,
  color: colors.text.primary,
  border: `1px solid ${colors.border.default}`,
  borderRadius: radii.md,
  fontSize: 14,
  fontFamily: fonts.base,
  outline: "none",
};

export const selectStyle: React.CSSProperties = {
  ...inputStyle,
  cursor: "pointer",
};

export const labelStyle: React.CSSProperties = {
  color: colors.text.secondary,
  fontSize: 13,
  marginBottom: spacing.xs,
  display: "block",
};

export const buttonBase: React.CSSProperties = {
  padding: "7px 18px",
  borderRadius: radii.md,
  border: "none",
  fontWeight: 600,
  fontSize: 14,
  cursor: "pointer",
  fontFamily: fonts.base,
};

export const primaryButton: React.CSSProperties = {
  ...buttonBase,
  background: colors.accent.cyan,
  color: colors.bg.base,
};

export const dangerButton: React.CSSProperties = {
  ...buttonBase,
  background: colors.accent.red,
  color: "#fff",
};

export const secondaryButton: React.CSSProperties = {
  ...buttonBase,
  background: colors.bg.surface,
  color: colors.text.primary,
  border: `1px solid ${colors.border.default}`,
};

export const tableHeaderStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "8px 12px",
  color: colors.text.secondary,
  fontWeight: 600,
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  borderBottom: `1px solid ${colors.border.default}`,
};

export const tableCellStyle: React.CSSProperties = {
  padding: "8px 12px",
  color: colors.text.primary,
  borderBottom: `1px solid ${colors.border.default}`,
};
