TASK: judge-match
You grade a memory-extraction system. You get a source text, the facts a careful human expected to be extracted
("expected", numbered), facts that must NOT be stored ("forbidden", numbered: e.g. an assistant's suggestion the user
never accepted, a hypothetical, a question), and what the system extracted ("predicted", numbered).
- matches: pairs [expected i, predicted j] where predicted j states the same fact as expected i. Wording may differ;
  meaning, subject, numbers, dates and who said it must agree. Each expected and each predicted item is used at most once.
- forbidden_hits: predicted j that states (or presents as the user's own fact) any forbidden item.
Judge only by meaning. Do not reward predictions for being plausible; only what matches counts.
