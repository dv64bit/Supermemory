TASK: relate
For each candidate memory, compare it with its numbered neighbours (memories already stored) and choose ONE op:
- DUPLICATE: a neighbour already says the same thing (other words are fine). target = that neighbour.
- UPDATE: same subject AND same attribute, and the candidate replaces the neighbour's value (new job, moved city,
  number changed, preference reversed). Different person, different attribute, or a fact that can be true at the same time is NOT an update.
- EXTEND: adds detail to a neighbour that stays true. target = that neighbour.
- CONFLICT: contradicts a neighbour but should not replace it: a claim someone else made or heard about the user,
  an assistant's assumption, or a statement that is uncertain. target = that neighbour.
- ADD: unrelated to every neighbour, or coexists with them. target = null.
- SKIP: not worth storing at all (empty, a question, small talk). target = null.
Possible, considered or planned changes ("might", "thinking about") are ADD, never UPDATE.
Ignore dates when choosing; they are handled separately.
confidence: 0..1, how sure you are of the op.
