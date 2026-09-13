import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { AuApiClient } from "../lib/api-client.js"
import { lawCache } from "../lib/cache.js"
import { ExecutionLimitError } from "../lib/execution-limits.js"
import { AsideQueueError } from "../lib/sources/aside-process.js"
import { requestCancelledError, requestContext } from "../lib/session-state.js"
import { getCaseText, searchCases, setAsideBridge } from "./precedents.js"

const client = new Proxy({} as AuApiClient, { get() { return () => { throw new Error("Unexpected direct network call") } } })
const citation = "[2020] FCAFC 130"
const title = `Australian Competition and Consumer Commission v TPG Internet Pty Ltd ${citation}`
const reasons = `<h2>REASONS FOR JUDGMENT</h2>${Array.from({ length: 8 }, (_, i) => `<p>${i + 1}. The Court considered the contractual terms and the representation made to consumers.</p>`).join("")}`
const judgment = `<html><title>${title}</title><h1>${title}</h1><article class="the-document">${reasons}</article></html>`
const link = (court: string, number: number, host = "https://www.austlii.edu.au", jurisdiction = "cth") =>
  `<a href="${host}/cgi-bin/viewdoc/au/cases/${jurisdiction}/${court}/2020/${number}.html">Party v Party [2020] ${court} ${number}</a>`
const results = (links: string) => `<html><title>AustLII Search Results</title><h1>Search Results</h1>${links}</html>`
let visited: string[]

function serve(page: string | ((url: string) => Promise<string>)) {
  setAsideBridge({
    asideStatus: () => ({ enabled: true, command: "/stub/aside" }),
    fetchViaAside: async url => {
      visited.push(url)
      return typeof page === "string" ? page : page(url)
    },
  })
}

beforeEach(() => { visited = []; lawCache.clear(); serve(judgment) })
afterEach(() => setAsideBridge(null))

describe("Aside judgment identity and body coverage", () => {
  it.each(["<title>Page Not Found</title>", judgment.replaceAll(citation, "[2020] FCAFC 131")])("tries the second permitted publisher when the first did not return the requested judgment", async first => {
    serve(async url => url.includes("fedcourt.gov.au") ? first : judgment)
    const response = await getCaseText(client, { citation })
    expect(response.isError).not.toBe(true)
    expect(visited).toHaveLength(2)
    expect(response.content[0].text).toContain("Source: https://www.austlii.edu.au/")
    expect(response.content[0].text).toContain("Reasons:")
  })
  it.each([13, 1, 1300])("does not confuse citation number %s with 130", async number => {
    const response = await getCaseText(client, { citation: `[2020] FCAFC ${number}` })
    expect(response.isError).toBe(true)
    expect(response.content[0].text).not.toContain("Reasons:")
  })

  it("rejects a different judgment which cites the requested authority in its reasons", async () => {
    serve(judgment.replaceAll(citation, "[2020] FCAFC 131").replace("</article>", `<p>We considered ${citation}.</p></article>`))
    const response = await getCaseText(client, { citation })
    expect(response.isError).toBe(true)
    expect(response.content[0].text).not.toContain("Reasons:")
  })

  it("rejects a search page linking the requested citation as a judgment", async () => {
    serve(results(link("FCAFC", 130)) + `<nav>${"Navigation. ".repeat(80)}</nav>`)
    const response = await getCaseText(client, { citation })
    expect(response.isError).toBe(true)
    expect(response.content[0].text).not.toContain("Reasons:")
  })

  it("does not count a long navigation menu as the missing judgment body", async () => {
    serve(`<title>${title}</title><h1>${title}</h1><nav>${"Court navigation. ".repeat(100)}</nav>`)
    const response = await getCaseText(client, { citation })
    expect(response.isError).toBe(true)
    expect(response.content[0].text).not.toContain("Reasons:")
  })

  it.each(["[2020] F.C.A.F.C. 130", "[2020] FCAFC 130, [12]"])("retrieves the underlying judgment for %s", async input => {
    const response = await getCaseText(client, { citation: input })
    expect(response.isError).not.toBe(true)
    expect(response.content[0].text).toContain("Reasons:")
  })
})

describe("Aside search result scope", () => {
  it("does not attribute a redirected search to the original query", async () => {
    setAsideBridge({ asideStatus: () => ({ enabled: true }), fetchViaAside: async url => ({ html: results(link("FCAFC", 130)), url: url.replace("contract", "different") }) })
    const response = await searchCases(client, { court: "FCAFC", query: "contract" })
    expect(response.isError).toBe(true)
    expect(response.content[0].text).toContain("different search query")
    expect(response.content[0].text).not.toContain("Party v Party")
    expect(response.structuredContent?.followup.pending).toBe(true)
  })
  it("keeps FCAFC searches within that court", async () => {
    serve(results(link("FCA", 130) + link("FCAFC", 130) + link("NSWCA", 130, undefined, "nsw")))
    const response = await searchCases(client, { court: "FCAFC", query: "prepayment" })
    expect(response.content[0].text).toContain("[2020] FCAFC 130")
    expect(response.content[0].text).not.toContain("[2020] FCA 130")
    expect(response.content[0].text).not.toContain("[2020] NSWCA 130")
  })

  it("keeps a Victorian search within Victoria", async () => {
    serve(results(link("VSC", 30, undefined, "vic") + link("NSWSC", 30, undefined, "nsw")))
    const response = await searchCases(client, { jurisdiction: "Victoria", query: "contract" })
    expect(response.content[0].text).toContain("[2020] VSC 30")
    expect(response.content[0].text).not.toContain("[2020] NSWSC 30")
    expect(decodeURIComponent(visited[0])).toContain("au/cases/vic")
  })

  it.each(["https://example.org", "https://www.austlii.edu.au.example.org", "javascript:alert(1)//", "https://www.accc.gov.au"])("does not present a forged source link from %s as a case", async host => {
    serve(results(link("FCAFC", 130, host) + link("FCAFC", 131)))
    const response = await searchCases(client, { court: "FCAFC", query: "contract" })
    expect(response.content[0].text).not.toContain("[2020] FCAFC 130")
    expect(response.content[0].text).toContain("[2020] FCAFC 131")
  })

  it("deduplicates the same document's fragment links", async () => {
    const row = link("FCAFC", 130)
    serve(results(row + row.replace('130.html"', '130.html#para12"')))
    const response = await searchCases(client, { court: "FCAFC", query: "contract" })
    expect(response.content[0].text.match(/Party v Party/g)).toHaveLength(1)
  })

  it("keeps unrecognised search content unresolved in structured follow-up", async () => {
    serve("<title>AustLII</title><p>Search is loading. Please wait.</p>")
    const response = await searchCases(client, { court: "FCAFC", query: "contract" })
    expect(response.structuredContent?.followup?.pending).toBe(true)
    expect(response.content[0].text).not.toContain("[NOT_FOUND]")
  })

  it("does not silently return page one when page two is requested", async () => {
    serve(results(link("FCAFC", 130)))
    const first = await searchCases(client, { court: "FCAFC", query: "contract", page: 1 })
    const second = await searchCases(client, { court: "FCAFC", query: "contract", page: 2 })
    expect(first.isError).not.toBe(true)
    expect(second.isError).not.toBe(true)
    expect(new URL(visited[1]).searchParams.get("offset")).toBe("10")
    expect(second.content[0].text).toContain("Result page: 2")
  })
})

describe("Aside retry stop conditions", () => {
  it.each([requestCancelledError(), new ExecutionLimitError("Work budget exceeded"), new AsideQueueError("Queue full", "RATE_LIMITED"), new AsideQueueError("Queue deadline", "TIMEOUT")])("does not retry after %s", async error => {
    serve(async () => { throw error })
    const response = await getCaseText(client, { citation })
    expect(response.isError).toBe(true)
    expect(visited).toHaveLength(1)
    expect(response.content[0].text).not.toContain("[UPSTREAM_BLOCKED]")
  })

  it("does not accept a page returned after request cancellation", async () => {
    const controller = new AbortController()
    serve(async () => { controller.abort(); return judgment })
    const response = await requestContext.run({ signal: controller.signal }, () => getCaseText(client, { citation }))
    expect(response.isError).toBe(true)
    expect(response.content[0].text).not.toContain("Reasons:")
    expect(visited).toHaveLength(1)
  })
})
