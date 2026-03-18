/**
 * Repairs and re-serializes MDX frontmatter so Mintlify always receives valid YAML.
 * French/Italian elisions (l'API, d'IA) break single-quoted YAML; we normalize then emit safe strings.
 *
 * @module mdx-frontmatter-sanitize
 */

import YAML from "yaml";

/** Unicode right single quotation mark — not a YAML string delimiter. */
const TYPOGRAPHIC_APOSTROPHE = "\u2019";

/**
 * Replaces ASCII apostrophes between letters (elisions, contractions) so single-quoted YAML
 * scalars do not terminate early. Safe for EN ("don't") and FR/IT ("l'API").
 *
 * @param text - Raw frontmatter block (without delimiters)
 * @returns Text safe to pass to YAML.parse in most cases
 */
export function fixElisionApostrophes(text: string): string {
  return text.replace(/(?<=[\p{L}\p{M}])'(?=[\p{L}\p{M}])/gu, TYPOGRAPHIC_APOSTROPHE);
}

/**
 * Serializes frontmatter data with double-quoted string values (JSON rules) to avoid delimiter bugs.
 *
 * @param data - Parsed frontmatter object
 * @returns YAML lines
 */
export function serializeFrontmatterSafe(data: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === null || v === undefined) {
      continue;
    }
    if (typeof v === "string") {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    } else if (typeof v === "boolean" || typeof v === "number") {
      lines.push(`${k}: ${String(v)}`);
    } else if (typeof v === "object") {
      lines.push(`${k}: ${YAML.stringify(v).trim()}`);
    } else {
      lines.push(`${k}: ${JSON.stringify(String(v))}`);
    }
  }
  return lines.join("\n");
}

export interface SanitizeResult {
  /** Full MDX with safe frontmatter */
  content: string;
  /** Whether parse + serialize succeeded */
  ok: boolean;
  /** Error detail when ok is false */
  error?: string;
}

/**
 * Parses frontmatter (after elision fix), re-emits with safe quoting.
 *
 * @param fullMdx - Complete MDX file contents
 * @returns Updated MDX or ok: false if frontmatter is still invalid
 */
export function sanitizeMdxFrontmatter(fullMdx: string): SanitizeResult {
  const m = fullMdx.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)([\s\S]*)$/);
  if (!m) {
    return { content: fullMdx, ok: false, error: "No valid --- frontmatter block found" };
  }
  const [, fmRaw, , body] = m;
  const repaired = fixElisionApostrophes(fmRaw);
  let data: unknown;
  try {
    data = YAML.parse(repaired);
  } catch (e) {
    return {
      content: fullMdx,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { content: fullMdx, ok: false, error: "Frontmatter must be a YAML mapping" };
  }
  const serialized = serializeFrontmatterSafe(data as Record<string, unknown>);
  return {
    content: `---\n${serialized}\n---\n${body}`,
    ok: true,
  };
}

/**
 * Validates that frontmatter parses after sanitization (round-trip check).
 *
 * @param fullMdx - MDX content
 * @returns ok true if sanitizable and re-parses
 */
export function validateSanitizedMdx(fullMdx: string): { ok: boolean; error?: string } {
  const r = sanitizeMdxFrontmatter(fullMdx);
  if (!r.ok) {
    return r;
  }
  const again = sanitizeMdxFrontmatter(r.content);
  if (!again.ok) {
    return { ok: false, error: `Round-trip failed: ${again.error}` };
  }
  return { ok: true };
}
