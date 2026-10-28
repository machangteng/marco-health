const SECRET_KEY = /pass.?token|service.?token|ssecurity|password|cookie|authorization/i;

/** Replace known secret values and credential query parameters. */
export function maskSecrets(text: string, secrets: readonly string[]): string {
  let masked = text;
  const values = [...secrets].filter((secret) => secret.length >= 4).sort((left, right) => right.length - left.length);
  for (const secret of values) {
    masked = masked.split(secret).join("[redacted]");
  }
  return masked.replace(
    /((?:passToken|serviceToken|ssecurity|pass_token|service_token)=)[^&\s"]+/gi,
    "$1[redacted]",
  );
}

/** Drop object keys that would carry credentials. Nested objects and arrays are walked. */
export function scrubSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => scrubSecrets(item));
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) continue;
      output[key] = scrubSecrets(inner);
    }
    return output;
  }
  return value;
}

export function safeMeta(value: unknown): Record<string, unknown> {
  const scrubbed = scrubSecrets(value);
  if (scrubbed !== null && typeof scrubbed === "object" && !Array.isArray(scrubbed)) {
    return scrubbed as Record<string, unknown>;
  }
  return {};
}
