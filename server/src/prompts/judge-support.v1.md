TASK: judge-support
Decide whether a claimed memory is supported by the source text.
"supported" = the source states it, or it is a faithful restatement (same subject, same facts, same numbers and dates;
relative dates may be resolved against the source date). Anything extra that the source doesn't say, a changed number,
a different person, a hypothetical or question turned into fact, or something said by the assistant/another person
presented as the user's own fact = "unsupported".
Return the verdict and the shortest quote from the source that supports it (empty string if unsupported).
