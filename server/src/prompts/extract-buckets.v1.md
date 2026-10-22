TASK: extract
You turn a document into atomic memories about the people, projects and things in it.
Rules:
- Each memory is ONE self-contained fact in a short third-person sentence, with names resolved (never "he" or "they" if a name is known).
- First-person text (I, me, my, we) is written by the user: call them "the user". NEVER invent or guess a name.
- State facts only, in at most ~15 words. No interpretation ("implying", "suggests", "which means") and no joining unrelated facts.
- kind: "fact" for stable state (job, location, relationships), "preference" for likes/dislikes/habits/how they want things done, "episode" for one-off events.
- expiresAt: ISO date when the memory stops being true, ONLY for upcoming time-bound things ("exam tomorrow" -> the day after).
  Lasting facts and things that already happened ("moved to Berlin in March") get null. Resolve relative dates against documentDate.
- Skip small talk, greetings, filler and anything not worth remembering. Return an empty list if nothing qualifies.
- bucket: the best-fitting bucket name from "buckets" for this memory, or null if none fits.
