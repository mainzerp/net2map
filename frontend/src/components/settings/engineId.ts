// SNMP engine ID helpers for the credential form.
// RFC 3411 SnmpEngineID: OCTET STRING (SIZE(5..32)). Accepts an optional "0x"
// prefix and ":" / whitespace separators; the backend normalizes the same way.

export function normalizeEngineId(value: string): string {
  let v = value.replace(/[\s:]/g, "").toLowerCase();
  if (v.startsWith("0x")) v = v.slice(2);
  return v;
}

/** Returns an error message, or "" when the value is valid or empty. */
export function validateEngineId(value: string): string {
  const v = normalizeEngineId(value);
  if (!v) return "";
  if (!/^[0-9a-f]+$/.test(v)) return "Only hex characters (0-9, a-f) are allowed";
  if (v.length % 2 !== 0) return "Engine ID needs an even number of hex characters";
  const octets = v.length / 2;
  if (octets < 5 || octets > 32) return "Engine ID must be 5-32 octets (10-64 hex characters)";
  return "";
}
