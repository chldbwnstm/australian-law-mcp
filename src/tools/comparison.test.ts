import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it } from "vitest"
import { normalizeFrlVersion, type AuApiClient } from "../lib/api-client.js"
import { lawCache } from "../lib/cache.js"
import { ErrorCodes, LawApiError } from "../lib/errors.js"
import type { FrlTitle, FrlVersion } from "../lib/types.js"
import { compareOldNew } from "./comparison.js"
import { diffStats, unifiedDiff } from "./statute-helpers/diff.js"

const VERSIONS = (
  JSON.parse(readFileSync(new URL("./__fixtures__/frl-versions-cca.json", import.meta.url), "utf8")) as { value: unknown[] }
).value.map(normalizeFrlVersion)

const CCA: FrlTitle = { id: "C2004A00109", name: "Competition and Consumer Act 2010", collection: "Act", status: "InForce", isPrincipal: true }

const OLD_TEXT = "45 Contracts\n(1) A corporation must not make a contract.\n(2) Nothing limits subsection (1)."
const NEW_TEXT = "45 Contracts, arrangements or understandings\n(1) A person must not make a contract.\n(2) Nothing limits subsection (1)."

function client(opts: { versions?: FrlVersion[]; provision?: (date?: string) => string } = {}): AuApiClient {
  const versions = opts.versions ?? VERSIONS
  return {
    getTitle: async () => CCA,
    listVersions: async () => versions,
    findVersion: async (p: { asAt?: string; registerId?: string }) => {
      if (p.registerId) return versions.find((v) => v.registerId === p.registerId) ?? versions[0]
      return versions.find((v) => (v.start ?? "") <= `${p.asAt}T00:00:00`) ?? versions[versions.length - 1]
    },
    getProvision: async (_id: string, _provision: string, date?: string) => {
      if (!opts.provision) throw new LawApiError("no text", ErrorCodes.NOT_FOUND)
      return { ref: "s 45", heading: "45", text: opts.provision(date), volumeDoc: "document_1/document_1.html", breadcrumb: [] }
    },
  } as unknown as AuApiClient
}

beforeEach(() => lawCache.clear())

describe("compare_old_new metadata", () => {
  it("names the amending Acts and their items for the compilations in between", async () => {
    const text = (await compareOldNew(client(), { registerId: "C2004A00109", fromDate: "2026-01-15", context: 2 } as never)).content[0].text
    expect(text).toContain("Treasury Laws Amendment (Payday Superannuation) Act 2025")
    expect(text).toContain("sch 1 (item 66)")
    expect(text).toContain("[C2025A00057]")
  })

  it("defaults the NEW side to the latest REGISTERED compilation, not a future one", async () => {
    // The fixture's newest rows are future commencements with registerId:null;
    // their text does not exist on the Register, so they are a bad default.
    expect(VERSIONS[0].registerId).toBeNull()
    const text = (await compareOldNew(client(), { registerId: "C2004A00109", fromDate: "2020-01-01", context: 2 } as never)).content[0].text
    expect(text).toMatch(/NEW {2}.*registerId: C2026C00323/)
  })

  it("labels an unregistered compilation instead of printing a blank id", async () => {
    const text = (await compareOldNew(client(), { registerId: "C2004A00109", fromDate: "2026-01-15", context: 2 } as never)).content[0].text
    expect(text).not.toContain("registerId: null")
  })

  it("refuses to compare a compilation with itself", async () => {
    const single = [VERSIONS[2]]
    const result = await compareOldNew(client({ versions: single }), {
      registerId: "C2004A00109",
      fromDate: "2026-07-02",
      context: 2,
    } as never)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/same compilation|nothing to compare/i)
  })
})

describe("compare_old_new text diff", () => {
  it("shows added and removed lines with a count", async () => {
    const c = client({ provision: (date) => (date === "2026-01-01" ? OLD_TEXT : NEW_TEXT) })
    const text = (await compareOldNew(c, { registerId: "C2004A00109", fromDate: "2026-01-15", provision: "s 45", context: 1 } as never)).content[0].text
    expect(text).toContain("- 45 Contracts")
    expect(text).toContain("+ 45 Contracts, arrangements or understandings")
    expect(text).toMatch(/2 line\(s\) added, 2 removed/)
  })

  it("says a diff is not a judgement about substance", async () => {
    const c = client({ provision: (date) => (date === "2026-01-01" ? OLD_TEXT : NEW_TEXT) })
    const text = (await compareOldNew(c, { registerId: "C2004A00109", fromDate: "2026-01-15", provision: "s 45", context: 1 } as never)).content[0].text
    expect(text).toContain("legal judgement the diff cannot make")
  })

  it("distinguishes a missing compilation document from a missing provision", async () => {
    const missingDoc = {
      ...client(),
      getProvision: async () => {
        throw new LawApiError("frlDocs returned 404 for .../epub/OEBPS/document.ncx", ErrorCodes.NOT_FOUND)
      },
    } as unknown as AuApiClient
    const text = (await compareOldNew(missingDoc, { registerId: "C2004A00109", fromDate: "2026-01-15", provision: "s 45", context: 1 } as never)).content[0].text
    expect(text).toContain("not available in machine-readable form")
    expect(text).not.toContain("inserted or repealed between these two compilations")
  })
})

describe("local unified diff", () => {
  it("marks unchanged runs rather than dropping them silently", () => {
    const a = ["a", "b", "c", "d", "e", "f", "g"].join("\n")
    const b = ["a", "b", "c", "d", "e", "f", "CHANGED"].join("\n")
    const out = unifiedDiff(a, b, 1)
    expect(out).toContain("unchanged line")
    expect(out).toContain("- g")
    expect(out).toContain("+ CHANGED")
  })

  it("reports identical text as no difference, not as an empty diff", () => {
    expect(unifiedDiff("same\ntext", "same\ntext", 2)).toBe("(no textual difference)")
    expect(diffStats("same", "same")).toEqual({ added: 0, removed: 0, unchanged: 1 })
  })

  it("refuses to diff texts beyond the size guard instead of diffing a prefix", () => {
    const huge = Array.from({ length: 1300 }, (_, i) => `line ${i}`).join("\n")
    expect(() => unifiedDiff(huge, `${huge}\nextra`, 1)).toThrow(/too large to diff/i)
  })
})
