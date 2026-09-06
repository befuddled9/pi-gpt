// PII / secret redaction for tool output. Ported from gpt2agent tools/_redact.py.

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PHONE_RE = /\+?\d[\d ()\-]{8,}\d/g;
const DATE_PREFIX_RE = /^(\d{4}-\d{2}-\d{2}|\d{1,2}-\d{1,2}-\d{4})(?=$|\D)/;

const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/\-]{16,}=*/gi;
const APIKEY_RE = /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g;
const GH_TOKEN_RE = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g;
const REFRESH_TOKEN_RE = /refresh_token["'=: ]+[A-Za-z0-9._~-]{20,}/gi;

function phoneRepl(text: string): string {
  const dm = DATE_PREFIX_RE.exec(text);
  if (!dm) return "<PHONE>";
  const prefix = dm[1];
  return prefix + text.slice(prefix.length).replace(PHONE_RE, phoneRepl);
}

export function redact(s: unknown): unknown {
  if (typeof s !== "string") return s;
  // Secrets first (a JWT/bearer must not survive by being partly eaten later).
  s = s.replace(JWT_RE, "<JWT>");
  s = s.replace(BEARER_RE, "Bearer <REDACTED>");
  s = s.replace(APIKEY_RE, "<APIKEY>");
  s = s.replace(GH_TOKEN_RE, "<TOKEN>");
  s = s.replace(REFRESH_TOKEN_RE, "refresh_token=<REDACTED>");
  s = s.replace(EMAIL_RE, "<EMAIL>");
  s = s.replace(PHONE_RE, (m) => phoneRepl(m));
  return s;
}

/** Scrub error bodies for safe logging — keeps it short. */
export function redactError(s: string, maxLen = 1000): string {
  const r = String(redact(s) as string);
  return r.length > maxLen ? r.slice(0, maxLen) + "…" : r;
}
