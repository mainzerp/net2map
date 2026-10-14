// On edit, secret fields left empty are omitted so the backend keeps the
// stored value instead of overwriting it.
const SECRET_FIELDS = ["community", "v3_auth_password", "v3_priv_password"] as const;

export function stripEmptySecrets(form: object): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...form };
  SECRET_FIELDS.forEach((k) => {
    if (payload[k] === "") delete payload[k];
  });
  return payload;
}

/** Throw the backend's "detail" message when a create returns one with a 2xx. */
export function throwOnDetail(r: { detail?: unknown } | null | undefined): void {
  if (r?.detail) throw new Error(typeof r.detail === "string" ? r.detail : JSON.stringify(r.detail));
}
