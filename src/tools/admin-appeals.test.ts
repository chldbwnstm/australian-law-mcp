import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import type { AuApiClient } from "../lib/api-client.js"
import { getAdminAppealText } from "./admin-appeals.js"

/**
 * Recorded upstream response (src/lib/sources/__fixtures__/provenance.txt,
 * captured 2026-09-04): GET caselaw.nsw.gov.au/search/advanced?…mnc=[2010] NSWCCA 333…
 */
const NSW_MNC = readFileSync(
  new URL("../lib/sources/__fixtures__/nsw-mnc-lookup.html", import.meta.url),
  "utf8",
)

/**
 * The same recording with its one result row dropped — the shape NSW Caselaw
 * returns when the advanced search matches nothing (header, result container,
 * no `class="row result"` block).
 */
const NSW_NO_ROWS = NSW_MNC.split('<div class="row result">')[0]

function client(html: string): AuApiClient {
  return { fetchHtml: async () => html } as unknown as AuApiClient
}

describe("get_decision_text[admin_appeals] — a zero-hit register is not a bad id", () => {
  it("reports an empty NCAT citation lookup as UPSTREAM_NO_DATA, not INVALID_PARAMETER", async () => {
    const result = await getAdminAppealText(client(NSW_NO_ROWS), { id: "[2023] NSWCATAP 100" })
    const text = result.content[0].text
    expect(text).toContain("[UPSTREAM_NO_DATA]")
    expect(text).not.toContain("[INVALID_PARAMETER]")
    expect(text).not.toContain("Unrecognised administrative-appeal id")
  })

  it("says the register's silence is not evidence the decision is absent", async () => {
    const text = (await getAdminAppealText(client(NSW_NO_ROWS), { id: "[2023] NSWCATAP 100" })).content[0].text
    expect(text).toContain("not a finding that the decision does not exist")
    expect(text).toContain("lawcite")
  })

  it("still rejects an id that is not an id at all", async () => {
    const text = (await getAdminAppealText(client(NSW_NO_ROWS), { id: "not-an-id" })).content[0].text
    expect(text).toContain("[INVALID_PARAMETER]")
    expect(text).toContain("Unrecognised administrative-appeal id")
  })
})
