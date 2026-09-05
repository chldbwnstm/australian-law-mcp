import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { beforeEach, describe, expect, it } from "vitest"
import { normalizeFrlVersion, type AuApiClient } from "../lib/api-client.js"
import { lawCache } from "../lib/cache.js"
import { parseSectionRef } from "../lib/section-ref.js"
import type { FrlTitle, FrlVersion } from "../lib/types.js"
import { enablingProvisionCall, instrumentRadar } from "./instrument-radar.js"
import { requireRef } from "./statute-helpers/toc.js"

const ACT_VERSIONS = (
  JSON.parse(readFileSync(new URL("./__fixtures__/frl-versions-cca.json", import.meta.url), "utf8")) as { value: unknown[] }
).value.map(normalizeFrlVersion)
const AUTHORISED_BY = JSON.parse(readFileSync(new URL("./__fixtures__/frl-authorisedby-ccr.json", import.meta.url), "utf8"))

const CCA: FrlTitle = { id: "C2004A00109", name: "Competition and Consumer Act 2010", collection: "Act", status: "InForce" }
const CCR: FrlTitle = { id: "F1996B01420", name: "Competition and Consumer Regulations 2010", collection: "LegislativeInstrument", status: "InForce" }

function version(start: string, registerId: string | null, compilation?: string): FrlVersion {
  return {
    titleId: "F1996B01420",
    start: `${start}T00:00:00`,
    end: null,
    isCurrent: true,
    isLatest: registerId !== null,
    registerId,
    ...(compilation ? { compilationNumber: compilation } : {}),
  }
}

function client(
  opts: {
    instrumentVersions?: FrlVersion[]
    acts?: FrlTitle[]
    actVersions?: () => Promise<FrlVersion[]>
    /** Replace `affectingProvisions` on the recorded expansion with another real value. */
    enablingProvision?: string | null
  } = {},
): AuApiClient {
  const acts = opts.acts ?? [CCA]
  const authorisedBy =
    opts.enablingProvision === undefined
      ? AUTHORISED_BY
      : {
          ...AUTHORISED_BY,
          value: [
            {
              ...AUTHORISED_BY.value[0],
              authorisedBy: (AUTHORISED_BY.value[0].authorisedBy as Array<Record<string, unknown>>).map((row) => ({
                ...row,
                affectingProvisions: opts.enablingProvision,
              })),
            },
          ],
        }
  return {
    getTitle: async () => CCR,
    listVersions: async (id: string) => {
      if (id === "F1996B01420") return opts.instrumentVersions ?? [version("2020-01-01", "F2020C00123", "12")]
      return opts.actVersions ? opts.actVersions() : ACT_VERSIONS
    },
    fetchJson: async (_host: string, path: string) =>
      path.includes("Search(criteria=")
        ? { "@odata.count": acts.length, value: acts }
        : authorisedBy,
  } as unknown as AuApiClient
}

const run = (c: AuApiClient, input: Record<string, unknown> = {}) =>
  instrumentRadar(c, { registerId: "F1996B01420", showActChanges: 2, ...input } as never)

beforeEach(() => lawCache.clear())

describe("instrument_radar flagging", () => {
  it("flags an Act amended after the instrument's last compilation, with follow-up ids", async () => {
    const text = (await run(client())).content[0].text
    expect(text).toContain("⚠️ REVIEW")
    expect(text).toContain("[C2026A00064]") // the amending Act's register id, for follow-up
    expect(text).toContain("further compilation(s)") // the rest are counted, not dropped
    expect(text).toContain("get_provision_history")
    expect(text).toContain('provision:"s 172"')
  })

  it("reports 'no signal' — never 'valid' — when the Act has not moved", async () => {
    const fresh = client({ instrumentVersions: [version("2099-01-01", "F2099C00001", "99")] })
    const text = (await run(fresh)).content[0].text
    expect(text).toContain("✅ No signal")
    expect(text).toContain("not a validity check")
    expect(text).not.toContain("⚠️ REVIEW")
  })

  it("frames a flag as something to check, not a finding of invalidity", async () => {
    const text = (await run(client())).content[0].text
    expect(text).toContain("is not a finding that the instrument is invalid")
    expect(text).toContain("Report it as something to check")
  })

  it("names the enabling provision it compared against", async () => {
    const text = (await run(client())).content[0].text
    expect(text).toContain("Enabling Act: Competition and Consumer Act 2010 [C2004A00109] — s 172")
  })
})

describe("instrument_radar refusals", () => {
  it("says nothing about currency when there is no enabling Act to compare", async () => {
    const text = (await run(client({ acts: [] }))).content[0].text
    expect(text).toContain("[NOT_FOUND]")
    expect(text).toContain("says nothing about whether the instrument is current")
    expect(text).not.toContain("✅")
  })

  it("marks an unreadable Act as unread rather than unchanged", async () => {
    const broken = client({
      actVersions: async () => {
        throw new Error("upstream 503")
      },
    })
    const text = (await run(broken)).content[0].text
    expect(text).toContain("Could not read the Act's compilations")
    expect(text).toContain("rather than treating it as unchanged")
    expect(text).toContain("No date comparison could be made")
  })

  it("does not compare when the instrument has no dated compilation", async () => {
    const undated = client({ instrumentVersions: [] })
    const text = (await run(undated)).content[0].text
    expect(text).toContain("no version rows")
    expect(text).toContain("no comparison is possible")
  })

  it("uses the greatest start date, not isLatest, as 'last compiled'", async () => {
    // isLatest marks the newest REGISTERED compilation, which can predate an
    // unregistered later version; taking it as the date would under-report.
    const versions = [version("2020-01-01", "F2020C00123", "12"), version("2026-09-01", null)]
    const text = (await run(client({ instrumentVersions: versions }))).content[0].text
    expect(text).toContain("Last compiled: 2026-09-01")
  })
})

// ── a suggested call must be one the caller can actually run ───────────────

/**
 * `authorisedBy.affectingProvisions` exactly as the Federal Register returns
 * it. Live-verified 2026-09-04 against `$expand=authorisedBy` for the
 * Competition and Consumer Act, the Fair Work Act, the Corporations Act and the
 * Migration Act: these are the 18 distinct values the four Acts' instruments
 * carry. Eight of them — every one below the divider — are rejected outright by
 * `parseSectionRef`, and before the fix each was interpolated verbatim into
 * `get_provision_history({provision:"…"})`, so the suggestion the tool printed
 * failed the moment the caller ran it.
 */
const REGISTER_ENABLING_PROVISIONS = [
  // Parse as given.
  "s 172",
  "s 1",
  "s 95AA",
  "s 56BA",
  "sch 2 s 134",
  "s 269P",
  "s 504",
  "s 601QA",
  "s 1364",
  "s 41",
  // Rejected by `parseSectionRef` — the eight that broke the follow-up call.
  "s 134 of sch 2",
  "s 134(1) of sch 2",
  "s 109(1)(b) of sch 2",
  "s 104(1) of sch 2",
  "s 95X(1) and (2)",
  "sch 2 (s 134(1))",
  "s 202(5), 205(3), 737(1), 768BK(1A)",
  "s 245J, 245K",
  "s 140GBA(4), (5), (6A)",
  // Paragraph-kind values returned live by the FRL API for in-force
  // instruments (2026-09-05). Round 4's `formatRef` printed these as
  // `para (1020F)` — an output its own parser rejected — so `canonical` now
  // round-trips what it suggests, not just what it read.
  "para 1020F(1)(c)",
  "para 601QA(1)(a), (b)",
  "para 184(a)",
] as const

/** Every `provision:"…"` argument the rendered output offers the caller. */
function suggestedProvisions(text: string): string[] {
  return [...text.matchAll(/provision:"([^"]*)"/g)].map((match) => match[1])
}

describe("instrument_radar never suggests a call its own parser would reject", () => {
  it.each(REGISTER_ENABLING_PROVISIONS)("%s", async (raw) => {
    const text = (await run(client({ enablingProvision: raw }))).content[0].text
    // Reproduced before the fix by this same loop: the eight unparseable
    // values came back as `provision:"s 134(1) of sch 2"` and friends, and
    // `requireRef` on them throws `[INVALID_PARAMETER] Not a recognisable
    // provision reference`.
    for (const suggestion of suggestedProvisions(text)) {
      expect(() => requireRef(suggestion), `${raw} → provision:"${suggestion}"`).not.toThrow()
    }
    // The Register's own wording is never lost, whichever branch was taken.
    expect(text, raw).toContain(raw)
  })

  it("normalises the schedule forms rather than dropping them", async () => {
    const text = (await run(client({ enablingProvision: "s 134(1) of sch 2" }))).content[0].text
    expect(suggestedProvisions(text)).toEqual(["sch 2 s 134(1)"])
    expect(text).toContain('the Register records the power as "s 134(1) of sch 2"')
  })

  it("says so when it narrowed a list to its first member", async () => {
    const text = (await run(client({ enablingProvision: "s 245J, 245K" }))).content[0].text
    expect(suggestedProvisions(text)).toEqual(["s 245J"])
    expect(text).toContain("the first of the provisions it names, so check the others too")
  })

  it("suggests no call at all when nothing can be normalised, and says why", async () => {
    // A value the Register could return that no rearrangement rescues.
    const text = (await run(client({ enablingProvision: "the Act generally" }))).content[0].text
    expect(suggestedProvisions(text)).toEqual([])
    expect(text).toContain('The Register records the power as "the Act generally"')
    expect(text).toContain("not a single provision reference")
    expect(text).toContain("no get_provision_history call is suggested")
  })

  it("says there is nothing specific to check when the Register records no provision", async () => {
    const text = (await run(client({ enablingProvision: null }))).content[0].text
    expect(suggestedProvisions(text)).toEqual([])
    expect(text).toContain("records no enabling provision for this Act")
  })

  it("leaves a value that already parses exactly as it is", async () => {
    const text = (await run(client({ enablingProvision: "s 172" }))).content[0].text
    expect(suggestedProvisions(text)).toEqual(["s 172"])
    expect(text).not.toContain("the Register records the power as")
  })
})

describe("enablingProvisionCall", () => {
  it("returns a reference `requireRef` accepts, or nothing at all", () => {
    for (const raw of REGISTER_ENABLING_PROVISIONS) {
      const call = enablingProvisionCall(raw)
      expect(call.provision, raw).toBeDefined()
      expect(() => requireRef(call.provision as string), raw).not.toThrow()
      expect(parseSectionRef(call.provision as string), raw).not.toBeNull()
    }
  })

  it("keeps the Register's string whenever the call differs from it", () => {
    expect(enablingProvisionCall("s 172")).toEqual({ provision: "s 172" })
    expect(enablingProvisionCall("s 104(1) of sch 2")).toEqual({
      provision: "sch 2 s 104(1)",
      raw: "s 104(1) of sch 2",
    })
    expect(enablingProvisionCall("s 95X(1) and (2)")).toEqual({
      provision: "s 95X(1)",
      raw: "s 95X(1) and (2)",
      narrowed: true,
    })
  })

  it("normalises nothing it cannot verify", () => {
    expect(enablingProvisionCall(undefined)).toEqual({})
    expect(enablingProvisionCall("   ")).toEqual({})
    expect(enablingProvisionCall("the Act generally")).toEqual({ raw: "the Act generally" })
    expect(enablingProvisionCall("made under the Act")).toEqual({ raw: "made under the Act" })
  })
})

describe("the sites that print a follow-up provision are enumerated", () => {
  // The class, not the instance. Round 3's lesson: a fix applied site-by-site
  // misses a site. Every `provision:"…"` this module emits must come from
  // `enablingProvisionCall`, so a new suggestion cannot silently interpolate a
  // raw Register string again.
  const SOURCE = readFileSync(fileURLToPath(new URL("./instrument-radar.ts", import.meta.url)), "utf8")

  it("every provision argument in the source is a verified one", () => {
    const interpolations = [...SOURCE.matchAll(/provision:\\?"\$\{([^}]*)\}\\?"/g)].map((match) => match[1].trim())
    expect(interpolations.length).toBeGreaterThan(0)
    for (const expression of interpolations) {
      expect(expression, `provision:"\${${expression}}"`).toMatch(/^call\.provision$/)
    }
  })

  it("no sibling tool file in this directory was left interpolating a raw enabling provision", () => {
    // Scoped to what this agent owns; `law-linkage.ts` has the same shape and
    // is fixed by its own owner. Listing the offenders here means a *new* one
    // in an owned file fails loudly.
    const OWNED = ["instrument-radar.ts", "impact-map.ts"]
    const directory = fileURLToPath(new URL("./", import.meta.url))
    for (const name of readdirSync(directory).filter((file) => OWNED.includes(file))) {
      const source = readFileSync(`${directory}${name}`, "utf8")
      for (const match of source.matchAll(/provision:\\?"\$\{([^}]*)\}\\?"/g)) {
        expect(match[1].trim(), `${name}: provision:"\${${match[1]}}"`).toMatch(/call\.provision|pinpoint|formatRef/)
      }
    }
  })
})
