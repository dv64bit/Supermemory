// Structure-aware chunker. Markdown splits on headings and keeps fenced code whole;
// prose splits on sentence boundaries with ~200 chars of overlap between chunks.
const MAX = 1200;
const OVERLAP = 200;

export function chunk(text: string): string[] {
  const sections = splitMarkdown(text.trim());
  return sections.flatMap((s) => (s.length <= MAX ? [s] : packSentences(s)));
}

function splitMarkdown(text: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) inFence = !inFence;
    if (!inFence && /^#{1,6}\s/.test(line) && cur.join("").trim()) {
      out.push(cur.join("\n").trim());
      cur = [];
    }
    cur.push(line);
  }
  if (cur.join("").trim()) out.push(cur.join("\n").trim());
  return out;
}

function packSentences(text: string): string[] {
  const sentences = text.match(/[^.!?\n]+(?:[.!?]+|\n+|$)/g) ?? [text];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && cur.length + s.length > MAX) {
      out.push(cur.trim());
      cur = cur.slice(-OVERLAP).replace(/^\S*\s/, ""); // overlap starts on a word boundary
    }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.flatMap((c) => (c.length <= MAX * 1.5 ? [c] : hardSplit(c)));
}

// ponytail: sentence-less blobs (minified code, CSV) get fixed windows; tree-sitter chunking when code matters.
function hardSplit(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += MAX - OVERLAP) out.push(s.slice(i, i + MAX));
  return out;
}
