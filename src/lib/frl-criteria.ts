/**
 * The Federal Register's `Titles/Search(criteria=…)` DSL — the single source
 * of that grammar (docs/research/frl-api-reference.md §2b).
 *
 * It is not OData and not a search box. Four rules make or break a query, and
 * each one fails *silently* rather than loudly, which is why they live in one
 * builder instead of being retyped at call sites:
 *
 *  1. **Search text is URI-encoded once inside the criteria.** The criteria
 *     value is then URL-encoded again on the wire, so a space reaches the
 *     server as `%2520`. `text()` performs the inner encoding; `encodeCriteria`
 *     performs the outer one.
 *  2. **`and`/`or` are functions, not infix.** `and(A,B)` — writing `A and B`
 *     parses and then quietly ignores `B`, returning a wider result set that
 *     looks perfectly plausible.
 *  3. **Enum arguments are bare tokens.** `collection(Act)`, not
 *     `collection('Act')`; the quoted form errors.
 *  4. **String arguments are double-quoted**, including dates:
 *     `pointintime("2015-06-30")` — but the keyword form is bare:
 *     `pointintime(Latest)`.
 *
 * Unknown function names return HTTP 400 `cannot parse <token>`, so a typo
 * here surfaces as a 400 and not as an empty result. That is the one failure
 * mode of this API that is honest.
 */

/** Which index `text()` searches. */
export type SearchType = "nameAndText" | "name" | "id"

/** How `text()` matches. `contains` is a phrase match, not a bag of words. */
export type MatchType = "contains" | "exact" | "startswith" | "excludes" | "any" | "all"

/** `Collection` enum members (from $metadata). */
export type FrlCollection =
  | "Act"
  | "LegislativeInstrument"
  | "NotifiableInstrument"
  | "AdministrativeArrangementsOrder"
  | "Constitution"
  | "ContinuedLaw"
  | "Gazette"
  | "PrerogativeInstrument"

/** `Status` enum members (from $metadata). */
export type FrlStatus = "InForce" | "Ceased" | "Repealed" | "NeverEffective"

/**
 * Affect kinds accepted by `affectedby(...)`. The first four are live-verified;
 * the last three come from the AffectSearch schema.
 */
export type AffectKind =
  | "repealing"
  | "amending"
  | "modifying"
  | "savingTransitionalOrApplication"
  | "ceasing"
  | "commencing"
  | "sunsetAltering"

/**
 * A built criteria fragment. It is a plain string, but the nominal type stops
 * a raw user phrase being passed where a fragment belongs — which is exactly
 * how a query ends up unencoded and silently over-broad.
 */
export type Criteria = string & { readonly __frlCriteria?: unique symbol }

/**
 * The inner encoding.
 *
 * `encodeURIComponent` is the base — the server decodes the criteria argument
 * with the matching decoder, so `%20`, `%26` and `%2C` all survive a phrase
 * containing a space, an ampersand or a comma. A bare comma would otherwise
 * read as the argument separator and change the call's arity.
 *
 * The extra characters below are the ones `encodeURIComponent` leaves alone
 * but this grammar cares about. `'` is the important one: the criteria travels
 * inside `criteria='…'`, so an unescaped apostrophe closes that literal and
 * the rest of the query becomes garbage — and Australian statute titles are
 * full of them (*Governor-General's Residences Act 1906*). Escaped as `%27`
 * it reaches the server as `%2527` and matches correctly (verified live
 * 2026-09-03: 157 hits, first result *Governor-General's Residences Act 1906*).
 * Parentheses are escaped for the same reason one level in: they are the
 * function-call syntax of this DSL.
 */
function encodeSearchText(phrase: string): string {
  return encodeURIComponent(phrase).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/** Reject a token that would land unquoted in the criteria and change its shape. */
function assertBareToken(kind: string, value: string): void {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(value)) {
    throw new Error(`Invalid ${kind} for FRL criteria: ${JSON.stringify(value)}`)
  }
}

/**
 * Full-text / title search.
 *
 * @param phrase raw human text — do **not** pre-encode it, this function owns
 *   the inner encoding and encoding twice here yields `%2520` on the wire's
 *   *first* level, which matches nothing.
 */
export function text(
  phrase: string,
  searchType: SearchType = "nameAndText",
  matchType: MatchType = "contains",
): Criteria {
  const trimmed = phrase.trim()
  if (!trimmed) throw new Error("FRL criteria text() needs a non-empty phrase")
  return `text("${encodeSearchText(trimmed)}",${searchType},${matchType})`
}

/** `collection(Act)` — bare enum tokens; the quoted form is rejected upstream. */
export function collection(...values: FrlCollection[]): Criteria {
  if (values.length === 0) throw new Error("FRL criteria collection() needs at least one value")
  values.forEach((value) => assertBareToken("collection", value))
  return `collection(${values.join(",")})`
}

/** `status(InForce)` — bare enum tokens. */
export function status(...values: FrlStatus[]): Criteria {
  if (values.length === 0) throw new Error("FRL criteria status() needs at least one value")
  values.forEach((value) => assertBareToken("status", value))
  return `status(${values.join(",")})`
}

/**
 * `pointintime("2015-06-30")` or `pointintime(Latest)`.
 *
 * The two forms differ in quoting, and passing a date bare (or a keyword
 * quoted) is a 400 rather than a wrong answer — but only because the parser
 * happens to be strict here, so the distinction is enforced locally too.
 */
export function pointintime(when: string): Criteria {
  const value = when.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `pointintime("${value}")`
  assertBareToken("pointintime keyword", value)
  return `pointintime(${value})`
}

/** Register IDs are alphanumeric, so no encoding applies — only a shape check. */
function assertTitleIdArg(fn: string, titleId: string): string {
  const value = titleId.trim()
  if (!/^[A-Za-z0-9]+$/.test(value)) {
    throw new Error(`Invalid FRL title id for ${fn}: ${JSON.stringify(titleId)}`)
  }
  return value
}

/** `id("C2004A00109")`. Register IDs are alphanumeric, so no encoding applies. */
export function id(titleId: string): Criteria {
  return `id("${assertTitleIdArg("criteria", titleId)}")`
}

/**
 * `authorises("C2004A00109")` — every title made under that Act.
 *
 * Undocumented, but real: unknown function names answer HTTP 400
 * `cannot parse <token>`, so a 200 is proof the parser knows the name.
 * Probed live 2026-09-04 — `authorises("C2004A00109")` returns the 647 titles
 * made under the CCA, while `enabledby`, `madeunder`, `enables` and the
 * American spelling `authorizedby` all 400. Composes inside `and(...)` with
 * `collection(...)` / `status(...)` like any other fragment.
 *
 * Lives here rather than in a tool helper because it is grammar, and a second
 * copy of a grammar is how one caller keeps quoting an id the other stopped
 * quoting.
 */
export function authorises(titleId: string): Criteria {
  return `authorises("${assertTitleIdArg("authorises()", titleId)}")`
}

/** `authorisedby("F1996B01420")` — the Act(s) an instrument was made under. */
export function authorisedby(titleId: string): Criteria {
  return `authorisedby("${assertTitleIdArg("authorisedby()", titleId)}")`
}

/**
 * `affectedby("C2004A00109",[amending])` — every title that amended, repealed
 * or modified the given one. The converse direction ("what does X amend") is
 * not exposed by the API at all; do not try to synthesise it here.
 */
export function affectedby(titleId: string, kinds: AffectKind[] = ["amending"]): Criteria {
  const value = assertTitleIdArg("affectedby", titleId)
  if (kinds.length === 0) throw new Error("FRL criteria affectedby() needs at least one affect kind")
  kinds.forEach((kind) => assertBareToken("affect kind", kind))
  return `affectedby("${value}",[${kinds.join(",")}])`
}

/**
 * Combine fragments. A single fragment is returned unwrapped — `and(x)` is
 * pointless noise in a URL, and an empty combine is a caller bug, not a
 * match-everything request.
 */
function combine(fn: "and" | "or", parts: Criteria[]): Criteria {
  const used = parts.filter((part) => part && part.trim().length > 0)
  if (used.length === 0) throw new Error(`FRL criteria ${fn}() needs at least one operand`)
  if (used.length === 1) return used[0]
  return `${fn}(${used.join(",")})`
}

export function and(...parts: Criteria[]): Criteria {
  return combine("and", parts)
}

export function or(...parts: Criteria[]): Criteria {
  return combine("or", parts)
}

/**
 * The outer encoding, applied once when the criteria goes on the wire.
 *
 * Kept separate from the builders so a criteria value can be inspected,
 * logged and unit-tested in its readable form. Applying it twice is the
 * classic bug: `%20` becomes `%2520` here, and a second pass would make it
 * `%252520`, which matches nothing and reports zero hits rather than an error.
 */
export function encodeCriteria(criteria: Criteria): string {
  return encodeURIComponent(criteria)
}

/**
 * The path segment for a criteria search, ready to append query options to.
 * Relative to the `frlApi` host base.
 */
export function titlesSearchPath(criteria: Criteria): string {
  return `Titles/Search(criteria='${encodeCriteria(criteria)}')`
}
