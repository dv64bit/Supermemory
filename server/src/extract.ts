import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

export type Extracted = { text: string; type: string; title: string | null; url: string | null };

const MAX_FETCH = 10 * 1024 * 1024;

// ponytail: text + URL only. PDF/office/image/audio extractors land in phase 6 behind this same fn.
export async function extract(raw: string): Promise<Extracted> {
  const trimmed = raw.trim();
  if (!/^https?:\/\/\S+$/i.test(trimmed)) return { text: raw, type: "text", title: null, url: null };

  const res = await fetch(trimmed, { redirect: "follow", headers: { "user-agent": "supermem/0.1" } });
  if (!res.ok) throw new Error(`fetch ${trimmed} -> ${res.status}`);
  const body = (await res.text()).slice(0, MAX_FETCH);
  if (!(res.headers.get("content-type") ?? "").includes("html")) {
    return { text: body, type: "webpage", title: null, url: trimmed };
  }
  const { document } = parseHTML(body);
  const article = new Readability(document as unknown as Document).parse();
  const text = article?.textContent?.replace(/\n{3,}/g, "\n\n").trim() || document.body?.textContent?.trim() || "";
  return { text, type: "webpage", title: article?.title || document.title || null, url: trimmed };
}

const CODE_EXT = new Set(["ts", "tsx", "js", "jsx", "mjs", "py", "go", "rs", "java", "kt", "swift", "rb", "php", "c", "h", "cpp", "hpp", "cs", "sh", "sql", "yaml", "yml", "toml", "css", "scss", "vue", "svelte"]);
export const MAX_FILE = 50 * 1024 * 1024;

export class UnsupportedFile extends Error {}

/** Uploaded file -> text. ponytail: no OCR/vision/whisper yet; scanned PDFs, images and audio are rejected. */
export async function extractFile(file: File): Promise<Extracted> {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const title = file.name;
  if (ext === "pdf" || file.type === "application/pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(await file.arrayBuffer()));
    const { text } = await extractText(pdf, { mergePages: false });
    const joined = (text as string[]).map((p) => p.trim()).filter(Boolean).join("\n\n");
    if (!joined.trim()) throw new UnsupportedFile("PDF has no extractable text (scanned PDFs need OCR, not supported yet)");
    return { text: joined, type: "pdf", title, url: null };
  }
  if (ext === "docx") {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(await file.arrayBuffer()) });
    return { text: value, type: "docx", title, url: null };
  }
  if (ext === "html" || ext === "htm") {
    const { document } = parseHTML(await file.text());
    const article = new Readability(document as unknown as Document).parse();
    return { text: article?.textContent?.trim() || document.body?.textContent?.trim() || "", type: "webpage", title: article?.title || title, url: null };
  }
  const type = ext === "md" || ext === "markdown" ? "markdown" : ext === "csv" ? "csv" : ext === "json" ? "json"
    : ext === "txt" ? "text" : CODE_EXT.has(ext) ? "code" : null;
  if (!type) throw new UnsupportedFile(`unsupported file type: .${ext || file.type}`);
  const text = await file.text();
  return { text: type === "code" ? `// ${file.name}\n${text}` : text, type, title, url: null };
}
