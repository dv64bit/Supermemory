// Retrieval v2 query understanding, rules only (PLAN.v2 §4.1). No LLM on the search path.
//  - First person -> third: memories say "The user lives in Pune", people ask "Which city do I live in?". Lining the
//    two up lets the user's own facts beat the same kind of fact about someone else.
//  - Temporal intent: "before", "used to", "in March 2025" -> also search superseded history; a named period is a range.
//  - Entity names to look up in `entities`: "my daughter" (as "the user's daughter") and capitalised names.
import { normName } from "./entities";

const FIRST_PERSON: [RegExp, string][] = [
  [/\b(i am|i'm)\b/gi, "the user is"],
  [/\b(i have|i've)\b/gi, "the user has"],
  [/\b(i was)\b/gi, "the user was"],
  [/\b(i will|i'll)\b/gi, "the user will"],
  [/\b(i'd)\b/gi, "the user would"],
  [/\bmy\b/gi, "the user's"],
  [/\bmine\b/gi, "the user's"],
  [/\bmyself\b/gi, "the user"],
  [/\bme\b/gi, "the user"],
  [/\bi\b/gi, "the user"],
  [/\b(our|ours)\b/gi, "the user's"],
  [/\b(we|us)\b/gi, "the user"],
];

/** "Which city do I live in?" -> "Which city does the user live in?". Text without first-person words is unchanged. */
export function thirdPerson(query: string): string {
  let out = query;
  for (const [re, to] of FIRST_PERSON) out = out.replace(re, to);
  // "do the user live" reads badly to the embedder; fix the auxiliary that now has a third-person subject.
  return out.replace(/\bdo the user\b/gi, "does the user").replace(/\bam the user\b/gi, "is the user").replace(/\bhave the user\b/gi, "has the user");
}

const HISTORY = /\b(used to|before|previous(ly)?|former(ly)?|earlier|history|in the past|back (in|when)|originally|anymore|any more|no longer)\b/i;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const PERIOD = new RegExp(`\\b(?:in|during|since|by)\\s+(?:(${MONTHS.join("|")})\\s+)?((?:19|20)\\d\\d)\\b`, "i");

export type Range = { from: Date; to: Date };
export type Understood = { text: string; history: boolean; range: Range | null; names: string[] };

/** A named month or year in the query, as a half-open range. */
function period(query: string): Range | null {
  const m = query.match(PERIOD);
  if (!m) return null;
  const year = Number(m[2]);
  if (!m[1]) return { from: new Date(Date.UTC(year, 0, 1)), to: new Date(Date.UTC(year + 1, 0, 1)) };
  const month = MONTHS.indexOf(m[1].toLowerCase());
  return { from: new Date(Date.UTC(year, month, 1)), to: new Date(Date.UTC(year, month + 1, 1)) };
}

// Capitalised words that start questions or are months/days carry no entity.
const NOT_NAMES = new Set(["what", "which", "who", "whom", "whose", "where", "when", "why", "how", "is", "are", "was", "were", "do", "does",
  "did", "can", "could", "should", "would", "will", "tell", "show", "list", "give", "find", "the", "a", "an", "i", "my", "any", "have", "has",
  ...MONTHS, "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);

function names(text: string): string[] {
  const out = new Set<string>();
  // "the user's daughter", "the user's manager": how aliases are stored (entities.ts normName).
  for (const m of text.matchAll(/\bthe user's ([a-z][a-z-]+)/gi)) out.add(`the user's ${m[1].toLowerCase()}`);
  // Runs of capitalised words: "Northwind Labs", "Anika", "Biscuit".
  for (const m of text.matchAll(/\b[A-Z][\p{L}\p{N}-]*(?:\s+[A-Z][\p{L}\p{N}-]*)*/gu)) {
    const words = m[0].split(/\s+/).filter((w) => !NOT_NAMES.has(w.toLowerCase()));
    if (words.length) out.add(normName(words.join(" ")));
  }
  return [...out].filter(Boolean);
}

export function understand(query: string): Understood {
  const text = thirdPerson(query);
  const range = period(query);
  return { text, history: HISTORY.test(query) || range !== null, range, names: names(text) };
}
