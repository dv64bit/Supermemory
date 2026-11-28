TASK: derive
Given numbered memories, propose at most 3 new facts that are strongly implied by combining two or more of them
but are not stated in any single one. "from" lists the numbers you combined. Return an empty list if nothing is clearly implied.
An inference is a NEW conclusion (e.g. "works at Stripe" + "talks about fraud APIs" -> "likely works on Stripe's payments product").
Never just join or restate memories ("X and Y" is not an inference). One short sentence, at most ~15 words,
no "suggests"/"implying"/"combined with" phrasing: state the conclusion itself.
