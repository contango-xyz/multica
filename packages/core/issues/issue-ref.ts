/**
 * Read what a person typed as a reference to ONE issue of the current
 * workspace (contango patch 50: find an issue by id).
 *
 * Accepted, with the workspace prefix `CTG`: `CTG-2850`, `ctg-2850`,
 * `ctg 2850`, `CTG2850`, `CTG_2850`, `#2850`, `2850`, and a pasted issue link
 * (`…/issues/CTG-2850`, optionally with `#comment-…` or `?…`). Returns the
 * canonical identifier (`CTG-2850`, prefix as the workspace stores it), or
 * null when the text is not an id of this workspace — a different prefix, a
 * number outside PostgreSQL int4, or ordinary words.
 *
 * The identifier feeds `issueIdentifierOptions`, an exact
 * `GET /api/issues/{identifier}` read through the unique
 * `(workspace_id, number)` index — never the full-text search — so the lookup
 * is instant and sees every issue, whatever its status, filters or views.
 *
 * Without a known prefix (workspace still loading) only the explicit
 * `PREFIX-NUMBER` form counts; the server still checks the prefix.
 */

const MAX_INT4 = 2_147_483_647;
const LINK_RE = /\/issues\/([a-z][a-z0-9]*-\d+)(?:[/?#]|$)/i;
const EXPLICIT_RE = /^([a-z][a-z0-9]*)-(\d+)$/i;

function toNumber(digits: string): number | null {
  if (!/^\d+$/.test(digits)) return null;
  const n = Number.parseInt(digits, 10);
  return Number.isSafeInteger(n) && n > 0 && n <= MAX_INT4 ? n : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseIssueRef(
  input: string,
  prefix: string | null | undefined,
): string | null {
  let text = input.trim();
  if (!text) return null;

  const link = LINK_RE.exec(text);
  if (link) text = link[1]!;
  if (text.startsWith("#")) text = text.slice(1).trim();

  const wsPrefix = prefix?.trim();
  if (!wsPrefix) {
    const m = EXPLICIT_RE.exec(text);
    if (!m) return null;
    const n = toNumber(m[2]!);
    return n === null ? null : `${m[1]!.toUpperCase()}-${n}`;
  }

  const bare = toNumber(text);
  if (bare !== null) return `${wsPrefix}-${bare}`;

  const withPrefix = new RegExp(`^${escapeRegExp(wsPrefix)}[\\s_-]*(\\d+)$`, "i").exec(text);
  if (!withPrefix) return null;
  const n = toNumber(withPrefix[1]!);
  return n === null ? null : `${wsPrefix}-${n}`;
}
