/**
 * FRL epub NCX table-of-contents parser (docs/research/frl-api-reference.md §3).
 *
 * The Register serves each compiled act's TOC as a DAISY NCX file whose
 * `<navPoint>` tree runs Volume → Chapter → Part → Division → section, with a
 * `<content src="document_N/document_N.html#_Toc…">` anchor per node. This
 * parser keeps two things the slicer cannot live without:
 *
 *  - **The parent chain.** CCA body s 18 ("Meetings of Commission") and
 *    Schedule 2 s 18 ("Misleading or deceptive conduct") have byte-identical
 *    label shapes; only the ancestor walk says which subtree a node sits in.
 *  - **Document order.** `playOrder` mirrors text order, so "the next anchor"
 *    is where a provision's text ends.
 *
 * It is a small hand parser rather than an XML dependency: the NCX grammar in
 * the wild is four token kinds, the labels never contain child elements, and
 * the reference project's experience is that a tolerant token scan survives
 * upstream quirks better than a strict parser that throws on them.
 */

import type { NcxEntry } from "./types.js"

export type { NcxEntry }

/**
 * Decode the entities NCX/XHTML text actually carries: the five XML named
 * entities plus numeric character references (`&#xa0;`, `&#8212;`). Unknown
 * named entities are left as written rather than guessed at.
 */
export function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]{1,7});/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

function safeCodePoint(code: number): string {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ""
}

/**
 * Label normalisation. FRL section labels separate number from heading with a
 * non-breaking space (`18  Misleading…`); pattern matching and display
 * both want ordinary single spaces.
 */
function normaliseLabel(raw: string): string {
  return decodeXmlEntities(raw).replace(/[\u00a0\u2007\u202f\s]+/g, " ").trim()
}

/**
 * The four token kinds a navMap is made of. `<text>` also appears inside
 * `<docTitle>`, which is why text outside an open navPoint is ignored below.
 */
const TOKEN =
  /<navPoint\b([^>]*)>|<\/navPoint\s*>|<text>([^<]*)<\/text>|<content\b[^>]*\bsrc="([^"]*)"[^>]*\/?>/g

/**
 * Parse an NCX document into a flat, document-ordered list of entries with
 * parent pointers. Malformed fragments are skipped, not fatal: a TOC with one
 * broken navPoint still describes the rest of the act.
 */
export function parseNcx(xml: string): NcxEntry[] {
  const entries: NcxEntry[] = []
  const stack: NcxEntry[] = []
  let fallbackOrder = 0

  for (const match of xml.matchAll(TOKEN)) {
    const [token, navPointAttrs, textContent, contentSrc] = match

    if (navPointAttrs !== undefined) {
      fallbackOrder += 1
      const playOrder = /\bplayOrder="(\d+)"/.exec(navPointAttrs)
      const entry: NcxEntry = {
        label: "",
        volumeDoc: "",
        order: playOrder ? Number(playOrder[1]) : fallbackOrder,
        depth: stack.length + 1,
        ...(stack.length > 0 ? { parent: stack[stack.length - 1] } : {}),
      }
      entries.push(entry)
      stack.push(entry)
      continue
    }

    if (token.startsWith("</navPoint")) {
      stack.pop()
      continue
    }

    const current = stack[stack.length - 1]
    if (!current) continue // <text> in <docTitle>, or a stray token

    if (textContent !== undefined) {
      // The first <text> inside a navPoint is its own navLabel; later ones
      // belong to children (which are on the stack by then).
      if (!current.label) current.label = normaliseLabel(textContent)
      continue
    }

    if (contentSrc !== undefined && !current.volumeDoc) {
      const src = decodeXmlEntities(contentSrc)
      const hash = src.indexOf("#")
      if (hash === -1) {
        current.volumeDoc = src
      } else {
        current.volumeDoc = src.slice(0, hash)
        current.anchor = src.slice(hash + 1)
      }
    }
  }

  return entries
}

/** Ancestors of an entry, outermost first (the volume node leads). */
export function ancestorsOf(entry: NcxEntry): NcxEntry[] {
  const chain: NcxEntry[] = []
  for (let node = entry.parent; node; node = node.parent) chain.unshift(node)
  return chain
}

/** `"document_4/document_4.html"` → `4`; undefined when the name has no number. */
export function volumeNumberOf(volumeDoc: string): number | undefined {
  const match = /document_(\d+)/.exec(volumeDoc)
  return match ? Number(match[1]) : undefined
}
