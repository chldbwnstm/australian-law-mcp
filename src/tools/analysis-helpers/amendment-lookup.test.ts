/**
 * The shared amendment-history lookup behind `applicable_law`, `cite_check`
 * and `impact_map`.
 *
 * Fixtures are the CCA's recorded epub members: `cca-schedules.ncx` lists
 * `Endnote 4—Amendment history` at `_Toc235543512` in document_4, and
 * `cca-endnote-amendments.html` is that volume. Pairing the TOC with a volume
 * that does not carry the anchor reproduces the upstream TOC/volume
 * disagreement — the condition `statute-helpers/toc.ts` documents as "a real
 * TOC/volume mismatch, which the caller must surface rather than widen".
 */
import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it } from "vitest"
import type { AuApiClient } from "../../lib/api-client.js"
import { lawCache } from "../../lib/cache.js"
import { parseNcx } from "../../lib/ncx-parser.js"
import { parseSectionRef } from "../../lib/section-ref.js"
import { amendedAfter, provisionHistory } from "./amendment-lookup.js"

const ENTRIES = parseNcx(readFileSync(new URL("../__fixtures__/cca-schedules.ncx", import.meta.url), "utf8"))
const ENDNOTE = readFileSync(new URL("../__fixtures__/cca-endnote-amendments.html", import.meta.url), "utf8")
const ANCHORLESS = "<html><body><p>Endnote 4 is not in this volume.</p></body></html>"

function client(html: string): AuApiClient {
  return {
    getToc: async () => ENTRIES,
    getVolumeHtml: async () => html,
  } as unknown as AuApiClient
}

const S18 = parseSectionRef("s 18")!

beforeEach(() => lawCache.clear())

describe("provisionHistory", () => {
  it("reads the endnote rows when the volume carries the anchor", async () => {
    const history = await provisionHistory(client(ENDNOTE), "C2004A00109", S18)
    expect(history.available).toBe(true)
    expect(history.rows).toHaveLength(1)
    expect(amendedAfter(history.rows, 1980)).not.toHaveLength(0)
  })

  it("reports a missing anchor as unavailable rather than as an empty table", async () => {
    const history = await provisionHistory(client(ANCHORLESS), "C2004A00109", S18)
    // `available: false` is what makes every caller print "[UPSTREAM_NO_DATA]
    // … not a finding that the provision was never amended". With `rows: []`
    // and `available: true` they instead print "no amending Act numbered YEAR
    // or later" — an absence read out of a parse failure.
    expect(history.available).toBe(false)
    expect(history.rows).toEqual([])
    expect(history.note).toContain("_Toc235543512")
    expect(history.note).toContain("disagree upstream")
  })

  it("does not cache the missing anchor as an empty table", async () => {
    // The endnote cache key is (title, date) only, so one cached [] would
    // answer "never amended" for every provision of this Act for the TTL.
    await provisionHistory(client(ANCHORLESS), "C2004A00109", S18)
    const second = await provisionHistory(client(ENDNOTE), "C2004A00109", S18)
    expect(second.available).toBe(true)
    expect(second.rows).toHaveLength(1)
  })
})
