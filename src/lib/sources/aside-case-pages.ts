/** Interpret publisher HTML without treating navigation, citations or search links as reasons. */
import { extractCaseCitations, parseCaseCitation, type MncCitation } from "../case-citation.js"
import { type Jurisdiction } from "../court-codes.js"
import { assertAsideUrl } from "./aside-browser.js"
import { attr, blockTextOf, elementsByClass, firstText, links } from "./html.js"

export function canonicalCaseCitation(input: string): string | undefined {
  const parsed = parseCaseCitation(input)
  return parsed.ok && parsed.citation.kind === "mnc"
    ? `[${parsed.citation.year}] ${parsed.citation.court} ${parsed.citation.number}` : undefined
}

function citations(text: string): MncCitation[] {
  return extractCaseCitations(text.replace(/\s+/g, " ")).flatMap(item => item.ok && item.citation.kind === "mnc" ? [item.citation] : [])
}

function identity(cite: MncCitation): string { return `[${cite.year}] ${cite.court} ${cite.number}` }

/** Preserve the printed numeric locators in AustLII's ol/li judgment template. */
export function judgmentText(html: string): string {
  const stack: Array<{ tag: string; next: number; type: string }> = []
  const numbered = html.replace(/<(\/?)(ol|ul|li)\b[^>]*>/gi, tag => {
    const match = /^<(\/?)(ol|ul|li)\b/i.exec(tag)!
    const name = match[2].toLowerCase()
    if (name !== "li") {
      if (match[1]) stack.pop()
      else stack.push({ tag: name, next: Number(attr(tag, "start") ?? 1), type: attr(tag, "type") ?? "1" })
      return tag
    }
    const list = stack[stack.length - 1]
    if (match[1] || list?.tag !== "ol" || list.type !== "1") return tag
    const number = Number(attr(tag, "value") ?? list.next)
    if (!Number.isSafeInteger(number) || number < 0) return tag
    list.next = number + 1
    return `${tag}${number}. `
  })
  return blockTextOf(numbered)
}

export type JudgmentPage = { title: string; text: string; citation: string; documents?: Array<{ label: string; url: string }> } | { failure: string }

export function readAsideJudgment(html: string, requested: string, sourceUrl?: string): JudgmentPage {
  const expected = canonicalCaseCitation(requested)
  if (!expected) return { failure: "the requested citation could not be identified" }
  const title = firstText(html, /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)
  const headings = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/gi)].map(m => blockTextOf(m[1]))
  const identities = [title ?? "", ...headings].flatMap(citations).map(identity)
  if (!identities.includes(expected) || identities.some(value => value !== expected)) {
    return { failure: "the page heading did not identify the requested citation; citations in the reasons or search links are insufficient" }
  }
  const container = elementsByClass(html, "article", "the-document", 1)[0]
    ?? elementsByClass(html, "div", "judgment_content", 1)[0]
    ?? elementsByClass(html, "div", "docx_judgment_content", 1)[0]
  const body = container?.inner ?? html
    .replace(/<(nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, " ")
  const text = judgmentText(body)
  const documentTitle = title ?? headings[0] ?? expected
  const reasons = /(?:^|\n)\s*(?:REASONS\s+FOR\s+(?:JUDGMENT|DECISION)|JUDGMENT|JUDGEMENT|RULING)\s*(?=\n|$)/i.exec(text)
  // Older WA pages mark the start with <a name="Judgment"> and numbered
  // paragraph anchors instead of a visible "REASONS FOR JUDGMENT" heading.
  const judgmentAnchor = /<a\b[^>]*(?:name|id)\s*=\s*["']Judgment["'][^>]*>/i.exec(body)
  const anchoredBody = judgmentAnchor ? body.slice(judgmentAnchor.index) : ""
  const hasParagraphAnchors = /<a\b[^>]*(?:name|id)\s*=\s*["']para1["']/i.test(anchoredBody)
    && /<a\b[^>]*(?:name|id)\s*=\s*["']para2["']/i.test(anchoredBody)
  const bodyAfterHeading = reasons ? text.slice(reasons.index + reasons[0].length)
    : hasParagraphAnchors ? judgmentText(anchoredBody) : ""
  // Short genuine reasons are valid; a long menu or coversheet is not.
  if (bodyAfterHeading.trim().length < 80 || !/(?:^|\n)\s*(?:\[\d{1,5}\]|\d{1,5}[. ]|[A-Z][A-Z'’ -]+\sJ[J:]?\b)/m.test(bodyAfterHeading)) {
    // Some AustLII judgments are PDF viewers. Preserve the exact original link
    // as a missing-body task, without calling viewer furniture judgment text.
    const paths = [...links(body).map(link => link.href), ...[...body.matchAll(/<(?:object|embed)\b[^>]*>/gi)].flatMap(match => [attr(match[0], "data"), attr(match[0], "src")].filter((value): value is string => !!value))]
    const documents = new Set<string>()
    for (const path of paths) {
      if (!sourceUrl) break
      try {
        const url = new URL(assertAsideUrl(new URL(path, sourceUrl).href))
        const pdf = /^\/au\/cases\/([^/]+)\/([^/]+)\/(\d{4})\/(\d+)\.pdf$/i.exec(url.pathname)
        const parsed = parseCaseCitation(expected)
        if (!/(?:^|\.)austlii\.edu\.au$/.test(url.hostname) || !pdf || !parsed.ok || parsed.citation.kind !== "mnc") continue
        if (canonicalCaseCitation(`[${pdf[3]}] ${pdf[2]} ${Number(pdf[4])}`) !== expected || pdf[1].toLowerCase() !== parsed.citation.court_info.jurisdiction.toLowerCase()) continue
        url.hash = ""
        documents.add(url.href)
      } catch { /* unrelated or invalid link */ }
    }
    if (documents.size) return { title: documentTitle, citation: expected, text: "", documents: [...documents].map(url => ({ label: "Original judgment PDF (body not extracted)", url })) }
    return { failure: "the page did not contain identifiable judgment reasons; its title or navigation alone is not the document" }
  }
  return { title: documentTitle, citation: expected, text }
}

export interface AsideSearchHit { title: string; url: string; citation: string }

/** SINO uses either ampersand or semicolon separators in its own links. */
export function asideSearchPageMatches(requested: string, actual: string): boolean {
  try {
    const target = new URL(requested)
    const final = new URL(assertAsideUrl(actual))
    if (!/(?:^|\.)austlii\.edu\.au$/.test(final.hostname) || final.pathname !== target.pathname) return false
    const expected = new URLSearchParams(target.search.slice(1).replace(/;/g, "&"))
    const observed = new URLSearchParams(final.search.slice(1).replace(/;/g, "&"))
    for (const key of ["query", "mask_path", "method"]) {
      if (JSON.stringify(expected.getAll(key).sort()) !== JSON.stringify(observed.getAll(key).sort())) return false
    }
    if (observed.getAll("offset").length > 1) return false
    return (expected.get("offset") ?? "0") === (observed.get("offset") ?? "0")
  } catch { return false }
}

export function asideSearchTotal(html: string): number | undefined {
  const title = firstText(html, /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i) ?? ""
  const matched = /^AustLII:\s*([\d,]+)\s+documents?\s+found\s+for\b/i.exec(title)
  if (!matched) return undefined
  const count = Number(matched[1].replace(/,/g, ""))
  return Number.isSafeInteger(count) && count >= 0 ? count : undefined
}

/** Only a publisher judgment URL with a matching visible citation earns a result row. */
export function readAsideSearchHits(html: string, sourceUrl: string, scope: { court?: string; jurisdiction?: Jurisdiction }): AsideSearchHit[] {
  const seen = new Set<string>()
  const out: AsideSearchHit[] = []
  for (const link of links(html)) {
    let url: URL
    try { url = new URL(assertAsideUrl(new URL(link.href, sourceUrl).href)) } catch { continue }
    if (url.hostname !== "austlii.edu.au" && !url.hostname.endsWith(".austlii.edu.au")) continue
    const path = /^\/(?:cgi-bin\/viewdoc)?\/?au\/cases\/([^/]+)\/([^/]+)\/(\d{4})\/(\d+)\.html$/i.exec(url.pathname)
    if (!path) continue
    const parsed = parseCaseCitation(`[${path[3]}] ${path[2]} ${Number(path[4])}`)
    if (!parsed.ok || parsed.citation.kind !== "mnc") continue
    const cite = parsed.citation
    if (path[1].toLowerCase() !== cite.court_info.jurisdiction.toLowerCase()) continue
    if (scope.court && cite.court !== scope.court) continue
    if (scope.jurisdiction && cite.court_info.jurisdiction !== scope.jurisdiction) continue
    const visible = citations(link.text)
    if (visible.length !== 1 || identity(visible[0]) !== identity(cite)) continue
    const key = identity(cite)
    if (seen.has(key)) continue
    seen.add(key)
    url.hash = ""
    out.push({ title: link.text, url: url.href, citation: key })
  }
  return out
}
