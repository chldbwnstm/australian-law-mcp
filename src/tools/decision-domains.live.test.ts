/**
 * Live smoke tests for the decision domains — **skipped unless `LIVE=1`**.
 *
 * `npm test` must never touch the network: the parser tests already run on
 * recorded fixtures, and a suite that silently depends on eleven government
 * websites is a suite that fails for reasons unrelated to the code. What
 * fixtures cannot check is the half of each source that is a *request*: the
 * literal-bracket facets, the form-encoded POST, the 90-second Queensland
 * timeout, the redirect chase on Western Australia's document links.
 *
 * So this file exists to be run deliberately:
 *
 *     LIVE=1 npx vitest run src/tools/decision-domains.live.test.ts
 *
 * It is polite by construction — one request per assertion, the client's own
 * per-host interval between them — and it asserts on shape, never on content
 * that upstream is free to change.
 */

import { describe, expect, it } from "vitest"
import { AuApiClient } from "../lib/api-client.js"
import * as ato from "../lib/sources/ato.js"
import * as dfat from "../lib/sources/dfat-treaties.js"
import * as fwc from "../lib/sources/fwc.js"
import * as hca from "../lib/sources/hcourt.js"
import * as nsw from "../lib/sources/nsw-caselaw.js"
import * as oaic from "../lib/sources/oaic.js"
import * as qld from "../lib/sources/qld-judgments.js"
import { searchNacc } from "../lib/sources/integrity-sources.js"
import { searchStateLaw } from "../lib/sources/state-legislation.js"
import { getDecisionText, searchDecisions } from "./unified-decisions.js"

const live = process.env.LIVE === "1" ? describe : describe.skip
const client = new AuApiClient()
const TIMEOUT = 120_000

live("live smoke — case law", () => {
  it("NSW simple search returns rows with decision ids", async () => {
    const result = await nsw.search(client, { query: "negligence", page: 0 })
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.hits[0].id).toMatch(/^[0-9a-f]{16,32}$/)
  }, TIMEOUT)

  it("NSW exact-MNC lookup finds one decision", async () => {
    const result = await nsw.lookupByCitation(client, "[2010] NSWCCA 333")
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0].citation).toBe("[2010] NSWCCA 333")
  }, TIMEOUT)

  it("the High Court year facet survives the WAF (literal brackets)", async () => {
    const result = await hca.search(client, { year: 2020 })
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.hits[0].citation).toMatch(/^\[2020\] HCA/)
  }, TIMEOUT)

  it("a Queensland citation resolves straight to its judgment", async () => {
    const document = await qld.getByCitation(client, "[2020] QSC 100")
    expect(document.citation).toBe("[2020] QSC 100")
    expect(document.text.length).toBeGreaterThan(500)
  }, TIMEOUT)
})

live("live smoke — tribunals and registers", () => {
  it("the ATO form POST returns a result list", async () => {
    const result = await ato.search(client, { allWords: "capital gains main residence", pageSize: 10 })
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.hits[0].id).toContain("/")
  }, TIMEOUT)

  it("an ATO product code resolves to exactly one document", async () => {
    const result = await ato.search(client, { phrase: "TR 2024/1" })
    expect(result.total).toBe(1)
    expect(result.hits[0].id).toBe("TXR/TR20241/NAT/ATO/00001")
  }, TIMEOUT)

  it("FWC row count is the row count, not the facet total", async () => {
    const result = await fwc.search(client, { query: "genuine redundancy" })
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.total).toBe(result.hits.length)
    expect(result.totalIsUnreliable).toBe(true)
  }, TIMEOUT)

  it("the OAIC determinations index parses", async () => {
    const result = await oaic.searchDeterminations(client, {})
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.hits[0].citation).toMatch(/AICmr/)
  }, TIMEOUT)

  it("the DFAT treaty API answers with records", async () => {
    const result = await dfat.search(client, { keyword: "extradition" })
    expect(result.records.length).toBeGreaterThan(0)
    expect(result.total).toBeGreaterThan(0)
  }, TIMEOUT)

  it("the NACC investigation-report index parses", async () => {
    const result = await searchNacc(client)
    expect(result.hits.length).toBeGreaterThan(0)
  }, TIMEOUT)
})

live("live smoke — the tool surface", () => {
  it("search_decisions(cases) merges the live sources and labels each hit", async () => {
    const result = await searchDecisions(client, { domain: "cases", query: "misleading conduct", limit: 6 })
    const text = result.content[0].text
    expect(text).toContain("source: ")
    expect(text).toMatch(/id: (nsw|hca|qld):/)
    // The Federal Court gap is always disclosed, never left to look like absence.
    expect(text).toMatch(/Federal Court judgments are not included/)
  }, TIMEOUT)

  it("get_decision_text(cases) returns reasons for a Queensland citation", async () => {
    const result = await getDecisionText(client, { domain: "cases", id: "qld:[2020] QSC 100" })
    const text = result.content[0].text
    expect(text).toContain("[2020] QSC 100")
    expect(text).toContain("Reasons:")
  }, TIMEOUT)

  it("get_decision_text(treaties) returns DFAT metadata plus the AustLII link", async () => {
    const search = await searchDecisions(client, { domain: "treaties", query: "extradition", limit: 3 })
    const id = /id: (\d+)/.exec(search.content[0].text)?.[1]
    expect(id).toBeTruthy()
    const result = await getDecisionText(client, {
      domain: "treaties",
      id: id as string,
      options: { keyword: "extradition" },
    })
    const text = result.content[0].text
    expect(text).toContain("[UPSTREAM_BLOCKED]")
    expect(text).toContain("austlii.edu.au")
  }, TIMEOUT)
})

live("live smoke — state legislation", () => {
  it("Queensland full-text search answers (slowly)", async () => {
    const result = await searchStateLaw(client, "QLD", "murder", { limit: 5 })
    expect(result.hits.length).toBeGreaterThan(0)
  }, TIMEOUT)

  it("Tasmania full-text search answers", async () => {
    const result = await searchStateLaw(client, "TAS", "dog", { limit: 5 })
    expect(result.hits.length).toBeGreaterThan(0)
  }, TIMEOUT)

  it("Western Australia's A–Z index doubles as the search surface", async () => {
    const result = await searchStateLaw(client, "WA", "criminal code", { limit: 5 })
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.hits[0].id).toMatch(/^(mrdoc_\d+|law_[a-z]\d+)$/)
  }, TIMEOUT)

  it("the Northern Territory By-Title list resolves a title", async () => {
    const result = await searchStateLaw(client, "NT", "criminal code", { limit: 5 })
    expect(result.hits.length).toBeGreaterThan(0)
  }, TIMEOUT)

  it("NSW and SA refuse before any request is made", async () => {
    await expect(searchStateLaw(client, "NSW", "crimes")).rejects.toThrowError(/not fetched by this server/)
    await expect(searchStateLaw(client, "SA", "crimes")).rejects.toThrowError(/not fetched by this server/)
  })
})
