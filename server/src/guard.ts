// Secret guard (D0): finds API keys, tokens, private keys, passwords and card numbers in text and replaces each with
// [REDACTED:<kind>]. Runs on ingest (before anything is stored, unless STORE_RAW_SECRETS=true), on extracted text
// (before chunks, memories and the extract LLM), and in the LLM router as a last line of defence.
// Findings carry kinds and counts only, never the matched values.

type Rule = { kind: string; re: RegExp; check?: (m: string) => boolean };

// Card-like numbers must pass the Luhn check, so ordinary long numbers (phone, order ids) are left alone.
const luhn = (s: string) => {
  const d = s.replace(/\D/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2) n = n * 2 > 9 ? n * 2 - 9 : n * 2;
    sum += n;
  }
  return sum % 10 === 0 && /^(?:4|5[1-5]|2[2-7]|3[47]|6)/.test(d); // Visa, Mastercard, Amex, Discover/UnionPay
};

// Most specific first: an Anthropic key must not be reported as an OpenAI one.
const RULES: Rule[] = [
  { kind: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { kind: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: "openai_key", re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { kind: "stripe_key", re: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: "aws_access_key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "github_token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/g },
  { kind: "gitlab_token", re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: "slack_token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "huggingface_token", re: /\bhf_[A-Za-z0-9]{30,}/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: "url_credentials", re: /(?<=\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(?=@)/gi },
  { kind: "bearer_token", re: /(?<=\bBearer\s+)[A-Za-z0-9._~+/=-]{20,}/g },
  // "password: hunter2", "db_password=...", "api key is ...": the value after a secret-looking label.
  {
    kind: "password",
    re: /(?<=(?<![A-Za-z0-9])(?:password|passwd|pwd|passphrase|secret|api[_ -]?key|access[_ -]?token|auth[_ -]?token|client[_ -]?secret)\b["']?\s*(?:is\s+|[:=]\s*)["']?)[^\s"',;]{6,}/gi,
    check: (m) => !m.startsWith("[REDACTED:"),
  },
  { kind: "card_number", re: /\b\d(?:[ -]?\d){12,18}\b/g, check: luhn },
];

export type Findings = Record<string, number>;

export function redact(text: string): { text: string; findings: Findings } {
  const findings: Findings = {};
  let out = text;
  for (const { kind, re, check } of RULES) {
    out = out.replace(re, (m) => {
      if (check && !check(m)) return m;
      findings[kind] = (findings[kind] ?? 0) + 1;
      return `[REDACTED:${kind}]`;
    });
  }
  return { text: out, findings };
}

export const storeRawSecrets = () => process.env.STORE_RAW_SECRETS === "true";
