import { describe, expect, it } from "vitest"
import { STATE_JURISDICTIONS } from "../lib/sources/state-legislation.js"
import { REGISTER_GRADES, getStateLawText, searchStateLaw } from "./state-law.js"

const noNetworkClient = new Proxy({} as never, {
  get() {
    return () => {
      throw new Error("network access in a unit test")
    }
  },
})

describe("REGISTER_GRADES", () => {
  it("describes every jurisdiction the source module knows", () => {
    for (const jurisdiction of STATE_JURISDICTIONS) {
      expect(REGISTER_GRADES[jurisdiction]).toBeTruthy()
    }
  })

  it("says plainly that NSW and SA are blocked", () => {
    expect(REGISTER_GRADES.NSW).toMatch(/^blocked/)
    expect(REGISTER_GRADES.SA).toMatch(/^blocked/)
  })

  it("records Victoria's client-side download links as a limitation", () => {
    expect(REGISTER_GRADES.VIC).toMatch(/rendered client-side/)
  })
})

describe("jurisdiction validation", () => {
  it("rejects an unknown jurisdiction and lists the valid ones", async () => {
    const result = await searchStateLaw(noNetworkClient, { jurisdiction: "Auckland", query: "dogs" })
    expect(result.isError).toBe(true)
    const text = result.content[0].text
    expect(text).toContain("[INVALID_PARAMETER]")
    expect(text).toContain("QLD, TAS, WA, VIC, NT, ACT, NSW, SA")
  })
})

describe("blocked registers", () => {
  it("returns [UPSTREAM_BLOCKED] with a deep link for NSW, not an empty result", async () => {
    const result = await getStateLawText(noNetworkClient, { jurisdiction: "NSW", id: "act-2010-123" })
    const text = result.content[0].text
    expect(result.isError).toBe(true)
    expect(text).toContain("[UPSTREAM_BLOCKED]")
    expect(text).toContain("legislation.nsw.gov.au/view/html/inforce/current/act-2010-123")
    expect(text).toMatch(/Do not report this as 'no such case\/legislation'/i)
  })

  it("does the same for South Australia", async () => {
    const text = (await searchStateLaw(noNetworkClient, { jurisdiction: "South Australia", query: "criminal law" }))
      .content[0].text
    expect(text).toContain("[UPSTREAM_BLOCKED]")
    expect(text).toContain("legislation.sa.gov.au")
  })
})
