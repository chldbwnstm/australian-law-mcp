import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it } from "vitest"
import type { AuApiClient } from "../lib/api-client.js"
import { lawCache } from "../lib/cache.js"
import { parseNcx } from "../lib/ncx-parser.js"
import type { FrlTitle } from "../lib/types.js"
import { getLawTree } from "./law-tree.js"
import { descendantsOf, provisionLeaves, renderTree, scheduleRoots, volumeRoots } from "./statute-helpers/toc.js"

const ENTRIES = parseNcx(readFileSync(new URL("./__fixtures__/cca-schedules.ncx", import.meta.url), "utf8"))
const CCA: FrlTitle = { id: "C2004A00109", name: "Competition and Consumer Act 2010", collection: "Act", status: "InForce", isPrincipal: true }

const client = {
  getTitle: async () => CCA,
  getToc: async () => ENTRIES,
} as unknown as AuApiClient

const run = (input: Record<string, unknown> = {}) =>
  getLawTree(client, { registerId: "C2004A00109", depth: 2, limit: 150, ...input } as never)

beforeEach(() => lawCache.clear())

describe("toc helpers", () => {
  it("finds the volume roots and the outermost schedule roots only", () => {
    expect(volumeRoots(ENTRIES).map((entry) => entry.label)).toEqual(["Volume 1", "Volume 4"])
    expect(scheduleRoots(ENTRIES)).toHaveLength(2)
  })

  it("counts a subtree without walking past its end", () => {
    const schedule2 = scheduleRoots(ENTRIES)[1]
    const inside = descendantsOf(ENTRIES, schedule2)
    expect(inside.length).toBeGreaterThan(5)
    expect(inside.every((entry) => entry.depth > schedule2.depth)).toBe(true)
    expect(inside.some((entry) => entry.label === "Endnotes")).toBe(false)
  })

  it("counts numbered provisions inside a schedule", () => {
    const schedule2 = scheduleRoots(ENTRIES)[1]
    expect(provisionLeaves(ENTRIES, schedule2).map((entry) => entry.label.split(" ")[0])).toContain("18")
  })

  it("reports the cut when a render hits its line limit", () => {
    const rendered = renderTree(ENTRIES, undefined, { maxDepth: 6, limit: 3 })
    expect(rendered.shown).toBe(3)
    expect(rendered.total).toBeGreaterThan(3)
  })
})

describe("get_law_tree", () => {
  it("renders an indented outline of the whole Act", async () => {
    const text = (await run()).content[0].text
    expect(text).toContain("Volume 1")
    expect(text).toContain("  Chapter 1—Preliminary")
  })

  it("re-roots at a schedule so the ACL can be browsed on its own", async () => {
    const text = (await run({ from: "sch 2", depth: 2, limit: 50 })).content[0].text
    expect(text).toContain("Rooted at: Schedule 2—The Australian Consumer Law")
    expect(text).toContain("Chapter 2—General protections")
    expect(text).toContain("Part 2-1—Misleading or deceptive conduct")
    expect(text).not.toContain("Schedule 1—The Schedule version")
  })

  it("states how many entries were cut instead of implying the tree is complete", async () => {
    const text = (await run({ from: "sch 2", depth: 3, limit: 5 })).content[0].text
    expect(text).toMatch(/more entries at this depth are NOT shown/)
  })

  it("notes when the Act spans several volumes", async () => {
    const text = (await run()).content[0].text
    expect(text).toContain("published in 2 volumes")
  })

  it("lists the real top-level nodes when `from` does not exist", async () => {
    const result = await run({ from: "sch 9" })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("Schedules present:")
    expect(result.content[0].text).toContain("Schedule 2—The Australian Consumer Law")
  })

  it("reaches section level at greater depth", async () => {
    const text = (await run({ from: "sch 2", depth: 3, limit: 200 })).content[0].text
    expect(text).toContain("18 Misleading or deceptive conduct")
  })
})
