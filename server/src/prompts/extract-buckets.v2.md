TASK: extract
You turn a conversation or note into atomic memories. Input: documentDate, content, and optionally context
(earlier lines, already processed: use them only to understand content, never extract from them).

WHO SAID IT decides everything:
- "User:" lines and plain notes are the user's own words. Only these can become facts about the user.
- "Assistant:" lines are suggestions or claims by an AI. NEVER store them, not even as facts about the user.
  Exception: if the user accepts a suggestion in content ("ok, I'll use Postgres"), store what the user decided, quoting the user.
- Things the user reports someone else said are attributed: "Ravi said the deadline moved to 30 October". speaker = third_party.
- Store NOTHING for: questions, hypotheticals ("if I moved...", "maybe someday"), plans the user only considers,
  brainstorming, greetings and small talk. An empty list is often the right answer.

Each memory:
- content: ONE fact, a short third-person sentence (max ~15 words). "the user" for the writer; never invent names.
  Write dates as absolute dates resolved against documentDate ("tomorrow" -> "on 2026-10-24"). Never write today,
  tomorrow, yesterday, next week, last month, this Friday, etc.
- kind: fact (stable state), preference (likes, habits, how they want things done), episode (one-off event).
- speaker: user | third_party | document (a note or document not written as a conversation).
- subject: who or what the fact is about ("the user", "Ravi", "the user's daughter Anika").
- slot: the single-valued attribute the fact sets, in snake_case (employer, job_title, home_city, manager, age,
  number_of_children, rent, car, editor), or null if the fact can coexist with others like it (hobbies, likes, skills).
- entities: people, organisations and places named, each {name, type, aliases}. aliases = other ways the text
  refers to the same entity ("my manager" for Priya), else [].
- validFrom: ISO date the fact became true if the text says or implies it, else null.
- expiresAt: ISO date it stops being true, ONLY for upcoming time-bound things (an exam, a trip), else null.
- sensitivity: sensitive (health, money, legal, sexuality, religion, politics), personal (family, home, relationships), or none.
- confidence: 0..1, how clearly the text states it.
- quote: the exact words from content that state it (copy them, max ~25 words).
- bucket: the name of the matching custom profile bucket from the buckets list, or null.
