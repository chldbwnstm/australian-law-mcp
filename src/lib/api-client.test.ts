import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AuApiClient, normalizeFrlVersion } from "./api-client.js"
import { lawCache } from "./cache.js"
import { ErrorCodes, LawApiError, UpstreamBlockedError } from "./errors.js"
import { authorises } from "./frl-criteria.js"
import { requestContext } from "./session-state.js"

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf-8")

/**
 * Router-style fetch stub: each test registers `pattern -> response body`.
 * Requests that match no route fail loudly so an unexpected upstream call
 * cannot pass silently.
 */
let routes: Array<{ match: (url: string) => boolean; body: string; status?: number; contentType?: string }>
let requested: string[]
/** Wall-clock moment each request left, in order — the politeness clock's evidence. */
let requestedAt: number[]

function route(substr: string, body: string, extra: { status?: number; contentType?: string } = {}) {
  routes.push({ match: (url) => url.includes(substr), body, ...extra })
}

beforeEach(() => {
  routes = []
  requested = []
  requestedAt = []
  // The TOC cache is process-global (shared with tools/statute-helpers/toc.ts),
  // so a warm entry from an earlier test would hide a real fetch from the next.
  lawCache.clear()
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      requested.push(url)
      requestedAt.push(Date.now())
      const hit = routes.find((r) => r.match(url))
      if (!hit) throw new Error(`api-client.test: no stub route for ${url}`)
      return new Response(hit.body, {
        status: hit.status ?? 200,
        headers: { "content-type": hit.contentType ?? "application/json" },
      })
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const client = () => new AuApiClient()

describe("blocked hosts", () => {
  it("refuses AustLII before any network call", async () => {
    await expect(client().fetchHtml("austlii", "au/cases/cth/HCA/2020/41.html")).rejects.toBeInstanceOf(
      UpstreamBlockedError,
    )
    expect(requested).toHaveLength(0)
  })
})

describe("searchTitles", () => {
  it("uses the criteria DSL Search path with double-encoded text", async () => {
    route("/Titles/Search", fixture("frl-titles-search.json"))
    const { count, titles } = await client().searchTitles({ text: "misleading or deceptive", collection: "Act" })
    expect(count).toBe(42)
    expect(titles.length).toBeGreaterThan(0)
    const url = requested[0]
    // %2520 = double-encoded space inside the criteria literal (frl-api-reference.md §2b)
    expect(url).toContain("misleading%2520or%2520deceptive")
    expect(url).toContain("collection(Act)")
    expect(url).toContain("$count=true")
  })

  it("uses plain $filter when `filter` is given and clamps $top to 100", async () => {
    route("/Titles?", fixture("frl-titles-search.json"))
    await client().searchTitles({ filter: "contains(name,'Privacy')", top: 500 })
    const url = requested[0]
    expect(url).toContain("$filter=contains(name%2C'Privacy')")
    expect(url).toContain("$top=100")
    expect(url).not.toContain("Search(criteria")
  })

  it("rejects a call with neither text nor filter", async () => {
    await expect(client().searchTitles({})).rejects.toBeInstanceOf(LawApiError)
    expect(requested).toHaveLength(0)
  })

  it("keeps `contains` as the default so existing callers do not move", async () => {
    route("/Titles/Search", fixture("frl-titles-search.json"))
    await client().searchTitles({ text: "misleading" })
    // The comma is percent-encoded on the wire, so the tail reads `%2Ccontains)`.
    expect(requested[0]).toContain("%2Ccontains)")
  })

  it("passes a caller's matchType through to the criteria", async () => {
    // `contains` is a phrase match. Measured live 2026-09-04 against the
    // notifiable-instrument collection, "CSIRO determination" returns 0 under
    // `contains` and 2 under `all` — so a keyword caller that cannot ask for
    // `all` reports absence for an ordinary two-word query.
    route("/Titles/Search", fixture("frl-titles-search.json"))
    await client().searchTitles({ text: "CSIRO determination", matchType: "all" })
    expect(requested[0]).toContain("%2Call)")
    expect(requested[0]).not.toContain("%2Ccontains)")
  })
})

describe("criteriaSearch", () => {
  it("runs a pre-built fragment with the same wire conventions as searchTitles", async () => {
    route("/Titles/Search", fixture("frl-titles-search.json"))
    const { count, titles } = await client().criteriaSearch(authorises("C2004A00109"), {
      top: 500,
      select: "id,name",
      expand: "authorisedBy",
      orderBy: "name asc",
    })
    const url = requested[0]
    expect(url).toContain("authorises(%22C2004A00109%22)")
    expect(url).toContain("$count=true")
    // The one clamp that matters: >100 is a 400 upstream.
    expect(url).toContain("$top=100")
    expect(url).toContain("$select=id%2Cname")
    expect(url).toContain("$expand=authorisedBy")
    expect(url).toContain("$orderby=name%20asc")
    expect(count).toBe(42)
    expect(titles.length).toBeGreaterThan(0)
  })

  it("falls back to the row count when the server omits @odata.count", async () => {
    route("/Titles/Search", JSON.stringify({ value: [{ id: "C2004A00109", name: "CCA" }] }))
    const { count } = await client().criteriaSearch(authorises("C2004A00109"))
    expect(count).toBe(1)
  })
})

describe("getTitle", () => {
  it("fetches by id filter and dedupes verbatim nameHistory duplicates", async () => {
    route(
      "/Titles?",
      JSON.stringify({
        value: [
          {
            id: "C2004A00109",
            name: "Competition and Consumer Act 2010",
            status: "InForce",
            nameHistory: [
              { name: "Trade Practices Act 1974", start: "1974-08-24T00:00:00" },
              { name: "Trade Practices Act 1974", start: "1974-08-24T00:00:00" },
              { name: "Competition and Consumer Act 2010", start: "2011-01-01T00:00:00" },
            ],
          },
        ],
      }),
    )
    const title = await client().getTitle("C2004A00109")
    expect(title.name).toBe("Competition and Consumer Act 2010")
    expect(title.nameHistory).toHaveLength(2)
  })

  it("rejects malformed register ids without a network call", async () => {
    await expect(client().getTitle("../etc/passwd")).rejects.toBeInstanceOf(LawApiError)
    expect(requested).toHaveLength(0)
  })
})

describe("listVersions", () => {
  it("never sends $expand and normalizes numeric enums", async () => {
    route("/Versions?", JSON.stringify({ value: [JSON.parse(fixture("frl-versions-find-asat.json"))] }))
    const versions = await client().listVersions("C2004A00109")
    expect(requested[0]).not.toContain("expand")
    expect(versions[0].status).toBe("InForce")
    expect(versions[0].registerId).toBe("C2015C00019")
  })
})

describe("findVersion", () => {
  it("asAt form: no trailing Z in the datetime, response normalized", async () => {
    route("Versions/Find(titleId=", fixture("frl-versions-find-asat.json"))
    const version = await client().findVersion({ titleId: "C2004A00109", asAt: "2015-06-30" })
    expect(requested[0]).toContain("asAt=2015-06-30T00:00:00")
    expect(requested[0]).not.toContain("Z")
    expect(version.status).toBe("InForce")
    expect(version.titleId).toBe("C2004A00109")
  })

  it("spec form passes asAtSpecification through", async () => {
    route("Versions/Find(titleId=", fixture("frl-versions-find-spec.json"))
    const version = await client().findVersion({ titleId: "C2004A00109", spec: "latest" })
    expect(requested[0]).toContain("asAtSpecification='latest'")
    expect(version.registerId).toBeTruthy()
  })

  it("rejects an unknown spec", async () => {
    await expect(
      client().findVersion({ titleId: "C2004A00109", spec: "newest" as never }),
    ).rejects.toBeInstanceOf(LawApiError)
    expect(requested).toHaveLength(0)
  })
})

describe("getProvision — end-to-end over recorded CCA fixtures", () => {
  const epub = "C2004A00109/latest/latest/text/latest/epub/OEBPS"

  beforeEach(() => {
    route(`${epub}/document.ncx`, fixture("cca-document.ncx"), { contentType: "application/x-dtbncx+xml" })
    route(`${epub}/document_1/document_1.html`, fixture("cca-vol1-slice.html"), { contentType: "text/html" })
    route(`${epub}/document_4/document_4.html`, fixture("cca-vol4-slice.html"), { contentType: "text/html" })
  })

  it("resolves body s 18 (Meetings of Commission), not the ACL section", async () => {
    const provision = await client().getProvision("C2004A00109", "s 18")
    expect(provision.heading).toContain("Meetings of Commission")
    expect(provision.volumeDoc).toBe("document_1/document_1.html")
    expect(provision.text.length).toBeGreaterThan(0)
  })

  it("resolves sch 2 s 18 inside the Schedule 2 subtree", async () => {
    const provision = await client().getProvision("C2004A00109", "sch 2 s 18")
    expect(provision.heading).toContain("Misleading or deceptive conduct")
    expect(provision.volumeDoc).toBe("document_4/document_4.html")
    expect(provision.text).toMatch(/misleading or deceptive/i)
    expect(provision.breadcrumb.join(" > ")).toMatch(/Schedule 2/)
  })

  it("reports NOT_FOUND with schedule guidance for a provision missing from the TOC", async () => {
    const err = await client()
      .getProvision("C2004A00109", "s 9999")
      .then(() => null, (e: LawApiError) => e)
    expect(err).toBeInstanceOf(LawApiError)
    expect(err?.code).toBe(ErrorCodes.NOT_FOUND)
    expect(String(err?.message)).toContain("9999")
  })
})

describe("getToc caching", () => {
  const epub = "C2004A00109/latest/latest/text/latest/epub/OEBPS"
  const ncx = () => fixture("cca-document.ncx")

  it("fetches the NCX once per (title, date), not once per provision", async () => {
    // No per-section endpoint exists, so every provision fetch needs the whole
    // TOC first — the CCA's is ~830 KB. Re-downloading it per provision spends
    // the request budget and a politeness interval on bytes already in hand.
    route(`${epub}/document.ncx`, ncx(), { contentType: "application/x-dtbncx+xml" })
    route(`${epub}/document_1/document_1.html`, fixture("cca-vol1-slice.html"), { contentType: "text/html" })
    route(`${epub}/document_4/document_4.html`, fixture("cca-vol4-slice.html"), { contentType: "text/html" })

    const c = client()
    await c.getProvision("C2004A00109", "s 18")
    await c.getProvision("C2004A00109", "sch 2 s 18")
    await c.getToc("C2004A00109")

    expect(requested.filter((url) => url.endsWith("document.ncx"))).toHaveLength(1)
  })

  it("keys by date, so a point-in-time TOC is never served as the current one", async () => {
    route("/latest/latest/text/latest/epub/OEBPS/document.ncx", ncx(), { contentType: "application/x-dtbncx+xml" })
    route("/2015-06-30/2015-06-30/text/latest/epub/OEBPS/document.ncx", ncx(), {
      contentType: "application/x-dtbncx+xml",
    })

    const c = client()
    await c.getToc("C2004A00109")
    await c.getToc("C2004A00109", "2015-06-30")

    expect(requested.filter((url) => url.endsWith("document.ncx"))).toHaveLength(2)
  })

  it("never caches a failure — an upstream error is about this attempt only", async () => {
    routes.push({
      match: (url) => url.endsWith("document.ncx"),
      body: "upstream is down",
      status: 500,
      contentType: "text/plain",
    })

    const c = client()
    const err = await c.getToc("C2004A00109").then(() => null, (e: LawApiError) => e)
    expect(err?.code).toBe(ErrorCodes.API_ERROR)

    // The same TOC, now healthy: a remembered failure would either replay the
    // error or, worse, stand in for the document.
    routes.length = 0
    route("document.ncx", ncx(), { contentType: "application/x-dtbncx+xml" })
    expect((await c.getToc("C2004A00109")).length).toBeGreaterThan(0)
  })
})

describe("per-host politeness", () => {
  it("also spaces retry attempts on scraped hosts", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("fetch", vi.fn(async () => {
      requestedAt.push(Date.now())
      return new Response("busy", { status: 503 })
    }))
    try {
      const pending = client().fetchHtml("fwc", "decisions").catch((error) => error)
      await vi.runAllTimersAsync()
      expect(await pending).toMatchObject({ code: ErrorCodes.API_ERROR })
      expect(requestedAt).toHaveLength(4)
      for (let i = 1; i < requestedAt.length; i++) {
        expect(requestedAt[i] - requestedAt[i - 1]).toBeGreaterThanOrEqual(1000)
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it("releases a cancelled caller while it is waiting for a host slot", async () => {
    vi.useFakeTimers()
    route("/decisions", "missing", { status: 404 })
    try {
      const c = client()
      await c.fetchHtml("fwc", "decisions").catch(() => {})
      const controller = new AbortController()
      let settled = false
      const pending = requestContext.run({ signal: controller.signal }, () =>
        c.fetchHtml("fwc", "decisions").catch((error) => {
          settled = true
          return error
        }),
      )
      controller.abort()
      await vi.advanceTimersByTimeAsync(0)
      const settledBeforeSlot = settled
      // Drain before asserting, including on the old implementation.
      await vi.runAllTimersAsync()
      expect(await pending).toMatchObject({ name: "AbortError" })
      expect(settledBeforeSlot).toBe(true)
      expect(requested).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("spaces a concurrent fan-out to one host instead of letting it burst", async () => {
    // get_law_statistics fans 8 count queries out through Promise.all. Reading a
    // "last request at" timestamp and writing it back after the sleep let all of
    // them read the same value and leave together, which is exactly the burst
    // minIntervalMs exists to prevent (ARCHITECTURE.md: ">=1 req/s per scraped
    // host"). frlApi's floor is 250ms.
    route("/Titles", JSON.stringify({ value: [] }))

    const c = client()
    await Promise.all([
      c.searchTitles({ filter: "id eq 'A'" }),
      c.searchTitles({ filter: "id eq 'B'" }),
      c.searchTitles({ filter: "id eq 'C'" }),
    ])

    expect(requestedAt).toHaveLength(3)
    const gaps = requestedAt.slice(1).map((at, index) => at - requestedAt[index])
    // Asserted below the 250ms floor to leave timer slack, and far above the
    // ~0ms three simultaneous departures produce.
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(200)
  })
})

describe("HTTP error mapping", () => {
  it("maps 404 to NOT_FOUND with a re-check suggestion", async () => {
    route("/Titles?", "not here", { status: 404, contentType: "text/plain" })
    const err = await client()
      .getTitle("C0000X00000")
      .then(() => null, (e: LawApiError) => e)
    expect(err).toBeInstanceOf(LawApiError)
    expect(err?.code).toBe(ErrorCodes.NOT_FOUND)
  })
})

describe("FRL response integrity", () => {
  const operations = [
    ["title lookup", (c: AuApiClient) => c.getTitle("C2004A00109")],
    ["title search", (c: AuApiClient) => c.searchTitles({ text: "Privacy" })],
    ["criteria search", (c: AuApiClient) => c.criteriaSearch(authorises("C2004A00109"))],
    ["versions", (c: AuApiClient) => c.listVersions("C2004A00109")],
    ["amenders", (c: AuApiClient) => c.listAmenders("C2004A00109")],
    ["documents", (c: AuApiClient) => c.fetchJson("frlApi", "Documents")],
  ] as const

  for (const [label, run] of operations) {
    it(`${label}: rejects a missing collection instead of reporting absence`, async () => {
      // Fault injection, not an invented successful upstream fixture.
      route("api.prod.legislation.gov.au", "{}")
      await expect(run(client())).rejects.toMatchObject({ code: ErrorCodes.PARSE_ERROR })
    })
  }

  it.each([
    { error: { message: "maintenance" } }, null, [],
    { value: null }, { value: {} }, { value: [null] },
    { value: [], "@odata.count": -1 }, { value: [], "@odata.count": "0" },
  ].map(body => ({ body })))("rejects malformed title data $body", async ({ body }) => {
    route("/Titles?", JSON.stringify(body))
    await expect(client().getTitle("C2004A00109")).rejects.toMatchObject({ code: ErrorCodes.PARSE_ERROR })
  })

  it("still reports authoritative absence for a valid empty title collection", async () => {
    route("/Titles?", JSON.stringify({ value: [], "@odata.count": 0 }))
    await expect(client().getTitle("C2004A00109")).rejects.toMatchObject({ code: ErrorCodes.NOT_FOUND })
  })
})

describe("normalizeFrlVersion", () => {
  it("turns PascalCase keys and numeric enums into the canonical shape", () => {
    const version = normalizeFrlVersion({
      TitleId: "C2004A00109",
      Start: "2015-01-01T00:00:00",
      Status: 2,
      Reasons: [{ Affect: 1, AffectedByTitle: { TitleId: "C2010A00103", SeriesType: 0 } }],
    })
    expect(version.titleId).toBe("C2004A00109")
    expect(version.status).toBe("Repealed")
    expect(version.reasons?.[0]?.affect).toBe("Amend")
  })
})
