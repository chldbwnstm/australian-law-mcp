/**
 * Minimal HTML reading helpers for the scraped sources under `src/lib/sources/`.
 *
 * There is no DOM library in this project's dependency set, and every page this
 * server reads is server-rendered with stable class/id landmarks (the recipes in
 * `docs/research/*`). So the parsers work on strings — but on strings through
 * *one* set of primitives, because the failure mode of ad-hoc per-file regexes is
 * that two modules disagree about what "the text of this element" means and a
 * result silently loses its citation.
 *
 * `extractElements` counts nesting depth rather than matching the first closing
 * tag: every one of these sites nests `<div>`s inside the row container it asks
 * us to read, and a non-counting matcher truncates the row at its first inner
 * `</div>` — which drops exactly the metadata the caller needs.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  bull: "•",
  middot: "·",
  eacute: "é",
  uuml: "ü",
  ouml: "ö",
}

/** Decode the entity forms these registers actually emit; leave anything else as written. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]{1,6}|[a-zA-Z]{2,10});/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code)
        } catch {
          return whole
        }
      }
      return whole
    }
    const named = NAMED_ENTITIES[body.toLowerCase()]
    return named ?? whole
  })
}

/** Collapse runs of whitespace (including NBSP) to single spaces and trim. */
export function collapse(text: string): string {
  return text.replace(/[\s ]+/g, " ").trim()
}

/**
 * `td`/`th` are here because NSW Caselaw and Queensland Judgments both render
 * the judgment coversheet as a two-column table: without a break between the
 * cells, "CITATION:" and the citation collapse into one line and the
 * label/value split that the metadata parser depends on disappears.
 */
const BLOCK_TAGS =
  "p|div|br|tr|td|th|li|h[1-6]|section|article|table|thead|tbody|ul|ol|dl|dt|dd|blockquote|hr|header|footer"

/**
 * Tag-strip to readable text. Script/style bodies are removed outright — they
 * are not content, and the ATO and Queensland pages embed multi-kilobyte CSS
 * blocks inside the same container as the judgment.
 */
export function stripTags(html: string): string {
  const withoutScripts = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
  const withBreaks = withoutScripts
    .replace(new RegExp(`<\\s*/?(?:${BLOCK_TAGS})\\b[^>]*>`, "gi"), "\n")
    .replace(/<[^>]{0,4000}>/g, "")
  return decodeEntities(withBreaks)
}

/** Element inner HTML → one line of plain text. */
export function textOf(html: string): string {
  return collapse(stripTags(html))
}

/**
 * Tag-strip preserving paragraph structure: blank-line separated blocks, each
 * internally collapsed. Used for judgment/ruling bodies where losing paragraph
 * boundaries makes the text unreadable.
 */
export function blockTextOf(html: string): string {
  return stripTags(html)
    .split("\n")
    .map((line) => collapse(line))
    .filter((line) => line.length > 0)
    .join("\n")
}

export interface ExtractedElement {
  /** The opening tag verbatim, e.g. `<div class="views-row foo">`. */
  openTag: string
  /** Everything between the opening and matching closing tag. */
  inner: string
  /** Index of the opening tag in the source string. */
  index: number
}

/**
 * Every `<tag …>` whose attributes satisfy `matches`, with nesting counted so
 * the returned `inner` is the whole element.
 *
 * `limit` bounds the work: these pages run to hundreds of kilobytes and a
 * caller only ever wants the first page of rows.
 */
export function extractElements(
  html: string,
  tag: string,
  matches: (openTag: string) => boolean,
  limit = 200,
): ExtractedElement[] {
  const out: ExtractedElement[] = []
  const opener = new RegExp(`<${tag}\\b[^>]{0,2000}>`, "gi")
  const scanner = new RegExp(`<${tag}\\b[^>]{0,2000}>|</${tag}\\s*>`, "gi")
  let match: RegExpExecArray | null
  while ((match = opener.exec(html)) !== null && out.length < limit) {
    const openTag = match[0]
    if (openTag.endsWith("/>") || !matches(openTag)) continue

    scanner.lastIndex = match.index + openTag.length
    let depth = 1
    let inner: string | null = null
    let scan: RegExpExecArray | null
    while ((scan = scanner.exec(html)) !== null) {
      if (scan[0].startsWith("</")) {
        depth -= 1
        if (depth === 0) {
          inner = html.slice(match.index + openTag.length, scan.index)
          break
        }
      } else if (!scan[0].endsWith("/>")) {
        depth += 1
      }
    }
    if (inner === null) inner = html.slice(match.index + openTag.length)
    out.push({ openTag, inner, index: match.index })
    // Skip past this element so a nested match of the same class is not
    // reported twice as a sibling.
    opener.lastIndex = match.index + openTag.length + inner.length
  }
  return out
}

/** Convenience: elements of `tag` whose `class` attribute contains every listed token. */
export function elementsByClass(
  html: string,
  tag: string,
  classTokens: string | string[],
  limit = 200,
): ExtractedElement[] {
  const tokens = Array.isArray(classTokens) ? classTokens : [classTokens]
  return extractElements(
    html,
    tag,
    (openTag) => {
      const classes = attr(openTag, "class")
      if (!classes) return false
      const list = classes.split(/\s+/)
      return tokens.every((token) => list.includes(token))
    },
    limit,
  )
}

/** Convenience: the first element of `tag` carrying `id="…"`. */
export function elementById(html: string, tag: string, id: string): ExtractedElement | undefined {
  return extractElements(html, tag, (openTag) => attr(openTag, "id") === id, 1)[0]
}

/** Read an attribute out of an opening tag. Handles `"`, `'` and bare values. */
export function attr(openTag: string, name: string): string | undefined {
  const quoted = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(openTag)
  if (quoted) return decodeEntities(quoted[2] ?? quoted[3] ?? "")
  const bare = new RegExp(`\\b${name}\\s*=\\s*([^\\s>]+)`, "i").exec(openTag)
  return bare ? decodeEntities(bare[1]) : undefined
}

export interface LinkHit {
  href: string
  text: string
}

/** Every `<a href>` in `html`, in document order, with its visible text. */
export function links(html: string, limit = 500): LinkHit[] {
  const out: LinkHit[] = []
  const pattern = /<a\b([^>]{0,2000})>([\s\S]{0,4000}?)<\/a\s*>/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null && out.length < limit) {
    const href = attr(`<a${match[1]}>`, "href")
    if (!href) continue
    out.push({ href, text: textOf(match[2]) })
  }
  return out
}

/** Resolve a possibly-relative href against a site base URL (no trailing slash). */
export function absoluteUrl(base: string, href: string): string {
  if (/^https?:\/\//i.test(href)) return href
  if (href.startsWith("//")) return `https:${href}`
  return href.startsWith("/") ? `${base}${href}` : `${base}/${href}`
}

/**
 * First capture group of `pattern` applied to `html`, as text.
 * Returns undefined rather than an empty string so callers can use `??`.
 */
export function firstText(html: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(html)
  if (!match) return undefined
  const value = textOf(match[1] ?? match[0])
  return value.length > 0 ? value : undefined
}
