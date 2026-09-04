/**
 * Checking one statute citation against the Federal Register.
 *
 * Three questions, in order, and each one can only be asked once the previous
 * has been answered:
 *
 *   1. **Which Act is this?** An alias miss, an ambiguous alias and an upstream
 *      failure all mean "unknown", and none of them means "no such Act". Only a
 *      Commonwealth citation the Register answered with nothing related earns a
 *      ✗ here; everything else is ⚠.
 *   2. **Does the provision exist?** Answered from the compilation's table of
 *      contents, which also supplies the range hint printed on a miss.
 *   3. **Does it say what the text claims?** Only asked when the prose actually
 *      describes the provision, and a failure is only reported as ✗ when the
 *      claim matches a *different* provision in the same Act — see
 *      `heading-index.ts` for why that distinction is the whole point.
 *
 * State and territory citations are ⚠ by construction: they are not on the
 * Federal Register and this server does not have their text, so it says so and
 * points at the register instead of guessing.
 */

import type { AuApiClient } from "../../lib/api-client.js"
import { headingTitle } from "../../lib/citation-content-matcher.js"
import { matchCitationContent } from "../../lib/citation-content-matcher.js"
import { ErrorCodes, LawApiError, UpstreamBlockedError } from "../../lib/errors.js"
import { resolveLawAlias } from "../../lib/law-alias.js"
import { findNavPoint } from "../../lib/provision-slicer.js"
import { vocabFor } from "../../lib/section-ref-vocab.js"
import type { FrlTitle, NcxEntry } from "../../lib/types.js"
import { matchedFormerName, titleAnnotations } from "../statute-helpers/format.js"
import { REGISTER_URLS } from "../statute-helpers/state-equivalents.js"
import { cachedToc } from "../statute-helpers/toc.js"
import { resolveTitle } from "../statute-helpers/title-lookup.js"
import { bestHeadingMatch, provisionRangeHint } from "./heading-index.js"
import { statuteNameCandidates, type StatuteCitation } from "./statute-citations.js"

export type Mark = "✓" | "✗" | "⚠"

export interface StatuteVerdict {
  mark: Mark
  line: string
  /** Set when the citation cannot be true as written — the hallucination signal. */
  impossible?: boolean
  /** The title the citation resolved to, for callers that follow up. */
  title?: FrlTitle
}

export interface StatuteCheckContext {
  /** Resolved titles by folded name, shared across the citations of one call. */
  titles: Map<string, FrlTitle | Error>
  /** Tables of contents by register id. */
  tocs: Map<string, NcxEntry[] | Error>
  /** Remaining upstream title lookups for this call. */
  lookupsLeft: number
}

/** A fresh context. `lookups` bounds the upstream work one call may do. */
export function newStatuteCheckContext(lookups = 6): StatuteCheckContext {
  return { titles: new Map(), tocs: new Map(), lookupsLeft: lookups }
}

/**
 * The citation as the reader wrote it, when the capture actually holds their
 * words. Echoing their own label is what makes a mismatch legible — "CCA s 18
 * is 'Meetings of Commission'" lands where "Competition and Consumer Act 2010
 * (Cth) s 18 is …" reads as being about some other citation.
 */
function label(cite: StatuteCitation): string {
  const name = cite.lawName
  if (name && cite.raw.toLowerCase().startsWith(name.toLowerCase()) && /\d/.test(cite.raw)) return cite.raw
  return name ? `${name} ${cite.pinpoint}` : cite.pinpoint
}

/**
 * Resolve a name to one FRL title, trying the shortened readings in turn.
 *
 * `year` is the year written in the citation, and it is tried first because the
 * name capture never contains one: the scanner's title body excludes digits, so
 * "Income Tax Assessment Act 1997 (Cth)" arrives here as the bare name plus a
 * separate year. Without it the Register's relevance order decides between the
 * 1922 and the 1997 Act — and it picked 1922, which turned the single most-cited
 * provision family in Australian tax law into a `✗ NOT_FOUND` against the wrong
 * statute. The year is what distinguishes same-named Acts; drop it and the
 * citation is no longer the citation the reader wrote.
 */
async function lookupTitle(
  client: AuApiClient,
  name: string,
  context: StatuteCheckContext,
  year?: number,
): Promise<FrlTitle | Error> {
  const key = `${name.toLowerCase()}|${year ?? ""}`
  const cached = context.titles.get(key)
  if (cached) return cached

  if (context.lookupsLeft <= 0) {
    const error = new LawApiError(
      "the per-request lookup budget for this call was already spent on other citations",
      ErrorCodes.RATE_LIMITED,
      ["Re-run with fewer citations (maxCitations) to check this one."],
    )
    context.titles.set(key, error)
    return error
  }

  const readings = statuteNameCandidates(name)
  const qualified = year !== undefined && !name.includes(String(year)) ? [`${name} ${year}`] : []
  // Bounded exactly as before: the year-qualified reading takes the first slot
  // rather than adding one, so the per-call lookup budget is unchanged.
  let last: Error = new LawApiError(`No reading of "${name}" resolved`, ErrorCodes.NOT_FOUND)
  for (const candidate of [...qualified, ...readings].slice(0, 3)) {
    if (context.lookupsLeft <= 0) break
    context.lookupsLeft--
    try {
      const found = await resolveTitle(client, { query: candidate })
      context.titles.set(key, found.title)
      return found.title
    } catch (error) {
      last = error instanceof Error ? error : new Error(String(error))
      // An ambiguity is a definite answer about the query — stop, do not let a
      // shortened reading resolve it by accident in one jurisdiction.
      if (error instanceof LawApiError && error.code === ErrorCodes.INVALID_PARAM) break
      if (error instanceof UpstreamBlockedError) break
      if (error instanceof LawApiError && error.code !== ErrorCodes.NOT_FOUND) break
    }
  }
  context.titles.set(key, last)
  return last
}

async function lookupToc(
  client: AuApiClient,
  titleId: string,
  context: StatuteCheckContext,
): Promise<NcxEntry[] | Error> {
  const cached = context.tocs.get(titleId)
  if (cached) return cached
  try {
    const entries = await cachedToc(client, titleId)
    context.tocs.set(titleId, entries)
    return entries
  } catch (error) {
    const wrapped = error instanceof Error ? error : new Error(String(error))
    context.tocs.set(titleId, wrapped)
    return wrapped
  }
}

/** Verify one statute citation. Never throws — every failure becomes a ⚠ line. */
export async function checkStatuteCitation(
  client: AuApiClient,
  cite: StatuteCitation,
  context: StatuteCheckContext,
): Promise<StatuteVerdict> {
  const shown = label(cite)

  if (!cite.lawName) {
    return {
      mark: "⚠",
      line:
        cite.attachedBy === "anaphora"
          ? `⚠ ${shown} — "the Act" has no full citation before it in this paragraph. Anaphora is never inherited across a blank line, so the Act is unknown and nothing was checked.`
          : `⚠ ${shown} — no statute is named near this pinpoint, so there is nothing to check it against.`,
    }
  }

  const alias = resolveLawAlias(cite.jurisdiction ? `${cite.lawName} (${cite.jurisdiction})` : cite.lawName)
  const jurisdiction = cite.jurisdiction ?? (alias.needsJurisdiction ? undefined : alias.candidates[0]?.jurisdiction)

  if (!cite.jurisdiction && alias.needsJurisdiction) {
    const list = alias.candidates.map((entry) => `${entry.official} (${entry.jurisdiction})`).join("; ")
    return {
      mark: "⚠",
      line:
        `⚠ ${shown} — jurisdiction unclear. "${cite.lawName}" names Acts in more than one jurisdiction: ${list}. ` +
        `AGLC r 3.1.3 requires the bracketed jurisdiction; without it this citation cannot be checked, and it is NOT wrong — only ambiguous.`,
    }
  }

  if (jurisdiction && jurisdiction !== "Cth") {
    return {
      mark: "⚠",
      line:
        `⚠ ${shown} — ${jurisdiction} legislation is not on the Federal Register, which is the only statute source this server reads. ` +
        `Nothing here says the provision is wrong. Check ${REGISTER_URLS[jurisdiction]} or use get_state_law.`,
    }
  }

  const title = await lookupTitle(client, cite.lawName, context, cite.year)
  if (title instanceof Error) return unresolvedTitle(cite, shown, title)

  const notes: string[] = []
  if (cite.ref.schedule && !/\bsch/i.test(cite.raw)) {
    notes.push(
      `read as ${cite.pinpoint}: "${cite.lawName}" names schedule ${cite.ref.schedule} of ${title.name}, not the body of the Act`,
    )
  }
  const former = matchedFormerName(cite.lawName, title)
  if (former) {
    notes.push(`cited under its former name "${former}" — now "${title.name}" (a rename, not a repeal; same register id)`)
  }
  for (const annotation of titleAnnotations(title)) notes.push(annotation.replace(/^[↳⚠️\s]+/, ""))

  const vocab = vocabFor(cite.ref.kind)
  if (vocab.ncxLabel === "none" || (cite.ref.kind === "item" && !cite.ref.schedule)) {
    return {
      mark: "⚠",
      title,
      line:
        `⚠ ${shown} — ${title.name} [${title.id}] exists, but a ${cite.ref.kind} is not listed in the table of contents, ` +
        `so its existence was not checked. Use get_law_text to read the surrounding section.`,
    }
  }

  const entries = await lookupToc(client, title.id, context)
  if (entries instanceof Error) {
    return {
      mark: "⚠",
      title,
      line:
        `⚠ ${shown} — ${title.name} [${title.id}] exists, but its table of contents could not be read ` +
        `(${entries.message}). This is a lookup failure, not evidence about the provision.`,
    }
  }

  const entry = findNavPoint(cite.ref, entries)
  if (!entry) {
    return {
      mark: "✗",
      impossible: true,
      title,
      line:
        `✗ NOT_FOUND: ${shown} — ${title.name} [${title.id}] has no ${cite.pinpoint} in its current compilation. ` +
        provisionRangeHint(entries, cite.ref) +
        (cite.ref.schedule ? "" : ' If a schedule provision was meant (the ACL, for example), write the prefix: "sch 2 s 18".'),
    }
  }

  const heading = headingTitle(entry.label)
  const suffix = notes.length > 0 ? ` [${notes.join("; ")}]` : ""

  if (cite.claim) {
    const result = matchCitationContent(cite.claim, heading)
    if (!result.matched) {
      const elsewhere = bestHeadingMatch(entries, cite.claim, entry)
      if (elsewhere) {
        return {
          mark: "✗",
          impossible: true,
          title,
          line:
            `✗ CONTENT_MISMATCH: ${shown} is '${heading}'; ${cite.claim} is ${elsewhere.ref}` +
            `${elsewhere.scheduleName ? ` (${elsewhere.scheduleName})` : ""}${suffix}`,
        }
      }
      return {
        mark: "⚠",
        title,
        line:
          `⚠ ${shown} exists and is headed '${heading}', which does not match the description in the text ` +
          `("${cite.claim}"). No other provision of ${title.name} matches that description either, so this may be a ` +
          `description of the section's body rather than its heading — read the text before relying on it.${suffix}`,
      }
    }
    return {
      mark: "✓",
      title,
      line: `✓ ${shown} — '${heading}' [${title.id}]; the description in the text matches the heading.${suffix}`,
    }
  }

  const subsectionNote = cite.ref.subsections.length > 0
    ? ` Subsection (${cite.ref.subsections.join(")(")}) was not checked — the table of contents lists sections only.`
    : ""
  return {
    mark: "✓",
    title,
    line: `✓ ${shown} — '${heading}' [${title.id}]${suffix}${subsectionNote}`,
  }
}

/**
 * A citation whose Act could not be resolved.
 *
 * The only path to ✗ is a citation that named the Commonwealth explicitly and
 * that the Register answered with nothing related: the Register is complete for
 * Commonwealth law, so that is real evidence. Ambiguity, an alias miss and any
 * upstream trouble stay ⚠.
 */
function unresolvedTitle(cite: StatuteCitation, shown: string, error: Error): StatuteVerdict {
  const code = error instanceof LawApiError ? error.code : undefined

  if (code === ErrorCodes.INVALID_PARAM) {
    return { mark: "⚠", line: `⚠ ${shown} — ${error.message}. Add the jurisdiction and re-check; the citation is ambiguous, not wrong.` }
  }
  if (code === ErrorCodes.NOT_FOUND && cite.jurisdiction === "Cth") {
    return {
      mark: "✗",
      impossible: true,
      line:
        `✗ NOT_FOUND: ${shown} — the Federal Register has no Commonwealth title matching "${cite.lawName}". ` +
        `The Register is complete for Commonwealth legislation, so a citation written "(Cth)" that it does not know ` +
        `is very likely invented or misspelled. Confirm with search_law before repeating it.`,
    }
  }
  if (code === ErrorCodes.NOT_FOUND) {
    return {
      mark: "⚠",
      line:
        `⚠ ${shown} — "${cite.lawName}" did not resolve on the Federal Register, and the citation names no jurisdiction. ` +
        `An alias miss is not evidence the Act does not exist; if it is state law it would not be on this register at all.`,
    }
  }
  return {
    mark: "⚠",
    line: `⚠ ${shown} — could not be checked: ${error.message}. This is a lookup failure, not a finding about the citation.`,
  }
}
