/**
 * How an upstream source says "there is no such record".
 *
 * Public legal-data endpoints commonly answer failures with HTTP 200, and the
 * shape of a miss body depends on the endpoint and response format:
 *
 *   - most single-record lookups: a normal XML/JSON envelope carrying a
 *     "no matching record" message → nothing to filter here
 *   - some endpoint/format combinations: 200 + **zero bytes**
 *   - others: 200 + an access-notice HTML page (its wording depends on the
 *     caller's registration state, so it must not be classified by phrase)
 *   - search endpoints: a normal envelope in every observed case — an empty
 *     body or HTML page there is a genuine outage
 *
 * So "an empty body may be a miss" is only true **on single-record lookup
 * paths**. Even there the body alone cannot separate a miss from maintenance
 * or overload, so the caller opts in with `singleRecordLookup` and the miss is
 * confirmed only after one short re-check.
 */

import { ExecutionLimitError } from "./execution-limits.js"
import { readBodyPrefix } from "./response-body.js"
import { getRequestSignal } from "./session-state.js"
import { isBlankBody, isHtmlPage } from "./body-shape.js"

export type BadBodyKind = "empty" | "html"

/**
 * Detect a 200 that carries an empty body or an HTML page (maintenance,
 * overload, access notice). Normal responses start with XML (`<`) or JSON
 * (`{`/`[`). The predicates themselves are defined only in `body-shape.ts`;
 * this function just attaches meaning to them.
 *
 * Exported for test reach — the only production consumer is this file.
 */
export function detectBadBody(text: string): BadBodyKind | null {
  if (isBlankBody(text)) return "empty"
  if (isHtmlPage(text)) return "html"
  return null
}

/**
 * Peek at only as much as the judgement needs. Empty-versus-HTML is decided in
 * the first few bytes, so there is no reason to clone and read the whole body —
 * that is what used to pull a multi-megabyte statute down twice and bill the
 * budget twice.
 */
const PROBE_BYTES = 1024

/**
 * Peek at the head of a 200 response (respecting cancellation) to decide
 * whether it signals a miss or an outage. If the body cannot be read (a failed
 * clone, say) the response is treated as normal and `null` is returned;
 * cancellation and budget exhaustion are rethrown so the caller aborts.
 */
export async function classifyOkBody(
  response: Response,
  externalSignal?: AbortSignal,
): Promise<BadBodyKind | null> {
  const inspection = response.clone()
  try {
    const { text, complete } = await readBodyPrefix(inspection, PROBE_BYTES)
    const bad = detectBadBody(text)
    // If the probe window is all whitespace but more body remains, "empty
    // body" is not a safe conclusion.
    return bad === "empty" && !complete ? null : bad
  } catch (error) {
    if (error instanceof ExecutionLimitError || getRequestSignal()?.aborted || externalSignal?.aborted) {
      // The request itself is ending — nobody will read the original, so drop
      // it here too and let the socket be reused.
      void response.body?.cancel().catch(() => {})
      throw error
    }
    return null
  } finally {
    // The peeked branch is always discarded. Never await: cancelling one side
    // of a tee does not settle until the other side is cancelled too.
    void inspection.body?.cancel().catch(() => {})
  }
}

/** Miss re-check interval — shorter than a typical upstream round trip, asked once. */
export const MISS_CONFIRM_DELAY_MS = 200

/**
 * A single-record lookup returned only an empty body / notice page even after
 * the confirmation retry. Thrown explicitly so an empty result is never passed
 * off as a successful response.
 *
 * Wording principle: this error is an **observation that the upstream did not
 * hand over the record**; it does not prove the record is absent. The message
 * states that the re-check was a single attempt 200ms later, so the caveat is a
 * checkable, bounded claim — a multi-minute outage looks identical 200ms later,
 * so this re-confirmation is weak evidence. Do not soften it to "not found"
 * (that implies absence).
 */
export class UpstreamRecordMissingError extends Error {
  /**
   * Which shape the emptiness took. Surface wording narrows the candidate
   * causes from it — this module can tell a notice page (unapproved access and
   * the like) apart from an empty body, and flattening that to two causes at
   * the surface leaves users being told to "retry shortly" for a condition
   * that retrying never fixes.
   */
  readonly kind: BadBodyKind

  /** @param maskedUrl a URL already passed through `maskSensitiveUrl()` (no key leakage) */
  constructor(maskedUrl: string, kind: BadBodyKind) {
    super(
      `The upstream service did not return the requested record ` +
      `(${kind === "empty" ? "empty body" : "notice page"} · unchanged after one re-check ${MISS_CONFIRM_DELAY_MS}ms later). ` +
      `${kind === "empty"
        ? "A record that is genuinely absent and an upstream outage or overload that empties the body cannot be told apart from this response alone"
        : "An absent record, upstream maintenance or overload, and an API key not approved for this endpoint all arrive in the same shape"} ` +
      `— do not settle on any one of them. - ${maskedUrl}`
    )
    this.name = "UpstreamRecordMissingError"
    this.kind = kind
  }
}
