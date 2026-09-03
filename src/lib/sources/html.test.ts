import { describe, expect, it } from "vitest"
import {
  absoluteUrl,
  attr,
  blockTextOf,
  collapse,
  decodeEntities,
  elementById,
  elementsByClass,
  extractElements,
  links,
  stripTags,
  textOf,
} from "./html.js"

describe("decodeEntities", () => {
  it("decodes named, decimal and hex entities", () => {
    // `&nbsp;` becomes an ordinary space, so the literal space before it and the
    // decoded one both survive - hence two spaces before `e`.
    expect(decodeEntities("A&amp;B &lt;c&gt; &#39;d&#39; &#x2014; &nbsp;e")).toBe("A&B <c> 'd' \u2014  e")
  })

  it("leaves an unknown entity as written rather than guessing", () => {
    expect(decodeEntities("&notarealentity;")).toBe("&notarealentity;")
  })

  it("does not decode an out-of-range code point", () => {
    expect(decodeEntities("&#1114112;")).toBe("&#1114112;")
  })
})

describe("stripTags", () => {
  it("drops script and style bodies outright", () => {
    const html = "<div>keep<script>var x = 1 < 2;</script><style>.a{color:red}</style>me</div>"
    expect(collapse(stripTags(html))).toBe("keep me")
  })

  it("puts a break between table cells so label/value pairs stay apart", () => {
    const html = "<tr><td>CITATION:</td><td>Dela Cruz v R</td></tr>"
    expect(stripTags(html).split("\n").map((l) => l.trim()).filter(Boolean)).toEqual([
      "CITATION:",
      "Dela Cruz v R",
    ])
  })
})

describe("blockTextOf", () => {
  it("keeps paragraph boundaries and collapses within them", () => {
    expect(blockTextOf("<p>one   two</p><p>three</p>")).toBe("one two\nthree")
  })
})

describe("extractElements", () => {
  it("counts nesting so an inner closing tag does not truncate the element", () => {
    const html = '<div class="row"><div class="inner">a</div>b</div><div class="row">c</div>'
    const rows = elementsByClass(html, "div", "row")
    expect(rows).toHaveLength(2)
    expect(textOf(rows[0].inner)).toBe("a b")
    expect(textOf(rows[1].inner)).toBe("c")
  })

  it("matches class tokens exactly, not as substrings", () => {
    const html = '<div class="rowdy">no</div><div class="row result">yes</div>'
    expect(elementsByClass(html, "div", ["row", "result"])).toHaveLength(1)
  })

  it("does not report a nested match of the same class as a sibling", () => {
    const html = '<div class="row"><div class="row">inner</div></div>'
    expect(elementsByClass(html, "div", "row")).toHaveLength(1)
  })

  it("honours the limit", () => {
    const html = '<li>a</li><li>b</li><li>c</li>'
    expect(extractElements(html, "li", () => true, 2)).toHaveLength(2)
  })

  it("finds an element by id", () => {
    const found = elementById('<div id="report-view">body</div>', "div", "report-view")
    expect(found && textOf(found.inner)).toBe("body")
  })
})

describe("attr", () => {
  it("reads double-quoted, single-quoted and bare values", () => {
    expect(attr('<a href="x">', "href")).toBe("x")
    expect(attr("<a href='y'>", "href")).toBe("y")
    expect(attr("<ol total=42>", "total")).toBe("42")
  })

  it("decodes entities in the value", () => {
    expect(attr('<a href="a?b=1&amp;c=2">', "href")).toBe("a?b=1&c=2")
  })
})

describe("links", () => {
  it("returns hrefs with their visible text in document order", () => {
    const found = links('<a href="/one">One</a><b>x</b><a href="/two"><em>Two</em></a>')
    expect(found).toEqual([
      { href: "/one", text: "One" },
      { href: "/two", text: "Two" },
    ])
  })

  it("skips anchors without an href", () => {
    expect(links('<a name="P1"></a><a href="/x">x</a>')).toHaveLength(1)
  })
})

describe("absoluteUrl", () => {
  it("leaves absolute urls alone and joins relative ones", () => {
    expect(absoluteUrl("https://h", "https://other/x")).toBe("https://other/x")
    expect(absoluteUrl("https://h", "/x")).toBe("https://h/x")
    expect(absoluteUrl("https://h", "x")).toBe("https://h/x")
    expect(absoluteUrl("https://h", "//cdn/x")).toBe("https://cdn/x")
  })
})
