/**
 * Judging the **shape** of an upstream response body — this is the only place
 * that answers these questions.
 *
 * When three call sites answered the same question with different predicates
 * (anchored + case-insensitive here, unanchored + case-sensitive there), a body
 * starting with lowercase `<!doctype html` was HTML to one and not to the
 * other. Divergent predicates make miss detection and error messages disagree.
 *
 * The three below are **different questions**, so they keep separate names
 * rather than being merged. Merging would give "the content contains HTML" and
 * "the response is an entire web page" the same answer.
 */

/** Is the body empty — whitespace-only counts. */
export function isBlankBody(text: string): boolean {
  return !text || !text.trim()
}

/**
 * Did an **entire web page** arrive where XML/JSON was expected (maintenance,
 * overload, anti-bot challenge or access-notice page)?
 *
 * Judged by a leading anchor. An unanchored `includes` would misread a normal
 * XML body as a maintenance page whenever `<html` appears inside CDATA — and
 * legislative text can legitimately carry such fragments. Case is ignored:
 * observed notice pages arrive as `<!DOCTYPE html>`, but nothing should hang on
 * that spelling.
 */
export function isHtmlPage(text: string): boolean {
  const t = text.trim()
  return /^<!doctype html/i.test(t) || /^<html[\s>]/i.test(t)
}

/**
 * Does this string carry HTML markup?
 *
 * Unlike the two above this is a **content** judgement, not an error
 * judgement — it decides whether an editor blob is formatted HTML or plain
 * text. The fragment's position is irrelevant, so no anchor is applied.
 */
export function containsHtmlMarkup(text: string): boolean {
  return /<html[\s>]/i.test(text) || /<body[\s>]/i.test(text)
}
