// Secret guard on a small secret corpus. Every key-shaped fixture is assembled at runtime: GitHub push protection
// rejects key-shaped literals, fake or not.
import { expect, test } from "bun:test";
import { redact } from "../src/guard";

const j = (...p: string[]) => p.join("");
const SECRETS: [kind: string, text: string, secret: string][] = [
  ["openai_key", "my key is SECRET ok", j("sk-", "proj-", "Zx81Kq0wVbT3B", "lbkFJ4mN7pQ2rS9tU6vW1xY")],
  ["anthropic_key", "export KEY=SECRET", j("sk-", "ant-", "api03-", "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW")],
  ["aws_access_key", "aws id SECRET in us-east-1", j("AKIA", "Z7QK2M4N6P8R0T3V")],
  ["github_token", "token: SECRET", j("ghp_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8")],
  ["slack_token", "slack SECRET", j("xox", "b-", "1234567890-", "abcdefghijKLMN")],
  ["google_api_key", "maps SECRET", j("AIza", "SyD3x7Kq9mN2pR5tV8wY1zB4cF6hJ0kL3mQ")],
  ["stripe_key", "stripe SECRET", j("sk_", "live_", "4eC39HqLyjWDarjtT1zdp7dc")],
  ["jwt", "Authorization: SECRET", j("eyJ", "hbGciOiJIUzI1NiJ9", ".", "eyJ", "zdWIiOiIxMjM0NTY3ODkwIn0", ".", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U")],
  ["private_key", "SECRET", j("-----BEGIN ", "RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7\n-----END ", "RSA PRIVATE KEY-----")],
  ["password", "my wifi password is SECRET, don't share", "Tr0ub4dor&3x"],
  ["password", "db_password: SECRET", "s3cr3t-Pa55"],
  ["url_credentials", "postgres://admin:SECRET@db.internal/app", "hunter2pass"],
  ["card_number", "card SECRET exp 04/29", "4111 1111 1111 1111"],
];

for (const [kind, template, secret] of SECRETS) {
  test(`redacts ${kind}`, () => {
    const { text, findings } = redact(template.replace("SECRET", secret));
    expect(text).not.toContain(secret);
    expect(text).toContain(`[REDACTED:${kind}]`);
    expect(findings[kind]).toBe(1);
  });
}

test("leaves ordinary text alone", () => {
  const clean = [
    "I drink green tea every morning and my rent went from 38k to 42k.",
    "Call me on +91 98765 43210; order number 1234567890123 shipped on 2026-10-22.",
    "Timestamp 1792734812000 and version sk-learn 1.5 are fine.",
    "I forgot my password again, can you remind me how to reset it?",
    "The task-runner uses a token bucket with a secret sauce of patience.",
  ];
  for (const t of clean) expect(redact(t)).toEqual({ text: t, findings: {} });
});

test("counts several secrets and keeps the rest of the text", () => {
  const a = j("AKIA", "Z7QK2M4N6P8R0T3V");
  const { text, findings } = redact(`first ${a}, then ${a}; I like green tea.`);
  expect(text).toBe("first [REDACTED:aws_access_key], then [REDACTED:aws_access_key]; I like green tea.");
  expect(findings).toEqual({ aws_access_key: 2 });
});
