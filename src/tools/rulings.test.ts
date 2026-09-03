import { describe, expect, it } from "vitest"
import { ABF_LINKS, PRODUCT_CODE, getRulingText, looksLikeDocId } from "./rulings.js"

const noNetworkClient = new Proxy({} as never, {
  get() {
    return () => {
      throw new Error("network access in a unit test")
    }
  },
})

describe("PRODUCT_CODE", () => {
  it("recognises the ATO's product codes", () => {
    for (const code of ["TR 2024/1", "TD 2017/20", "GSTR 2001/1", "PS LA 2009/9", "ATO ID 2006/34", "TR 2024/1A"]) {
      expect(PRODUCT_CODE.test(code)).toBe(true)
    }
  })

  it("does not treat free text as a code", () => {
    for (const text of ["main residence exemption", "TR2024/1", "capital gains 2024"]) {
      expect(PRODUCT_CODE.test(text)).toBe(false)
    }
  })
})

describe("looksLikeDocId", () => {
  it("accepts real DocIDs of both lengths", () => {
    // Rulings are five-segment, ATO IDs three — neither is derivable from the
    // other, which is why a code is resolved by search instead of constructed.
    expect(looksLikeDocId("TXR/TR20241/NAT/ATO/00001")).toBe(true)
    expect(looksLikeDocId("AID/AID200634/00001")).toBe(true)
    expect(looksLikeDocId("JUD/2026ATC10-800/00001")).toBe(true)
  })

  it("rejects a product code and an unknown prefix", () => {
    expect(looksLikeDocId("TR 2024/1")).toBe(false)
    expect(looksLikeDocId("ZZZ/whatever/00001")).toBe(false)
  })
})

describe("get_ruling_text", () => {
  it("rejects a malformed point-in-time date instead of sending a wrong one", async () => {
    const result = await getRulingText(noNetworkClient, {
      id: "TXR/TR20241/NAT/ATO/00001",
      asAt: "30 June 2002",
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/YYYY-MM-DD/)
  })
})

describe("customs coverage", () => {
  it("keeps Border Force links, since that host is not scraped", () => {
    expect(ABF_LINKS.every((link) => link.startsWith("https://www.abf.gov.au/"))).toBe(true)
  })
})
