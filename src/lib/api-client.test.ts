import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AuApiClient, normalizeFrlVersion } from "./api-client.js"
import { ErrorCodes, LawApiError, UpstreamBlockedError } from "./errors.js"

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf-8")

/**
 * Router-style fetch stub: each test registers `pattern -> response body`.
 * Requests that match no route fail loudly so an unexpected upstream call
 * cannot pass silently.
 */
let routes: Array<{ match: (url: string) => boolean; body: string; status?: number; contentType?: string }>
let requested: string[]

function route(substr: string, body: string, extra: { status?: number; contentType?: string } = {}) {
  routes.push({ match: (url) => url.includes(substr), body, ...extra })
}

beforeEach(() => {
  routes = []
  requested = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      requested.push(url)
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
