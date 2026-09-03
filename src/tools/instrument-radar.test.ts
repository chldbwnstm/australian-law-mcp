import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it } from "vitest"
import { normalizeFrlVersion, type AuApiClient } from "../lib/api-client.js"
import { lawCache } from "../lib/cache.js"
import type { FrlTitle, FrlVersion } from "../lib/types.js"
import { instrumentRadar } from "./instrument-radar.js"

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

function client(opts: { instrumentVersions?: FrlVersion[]; acts?: FrlTitle[]; actVersions?: () => Promise<FrlVersion[]> } = {}): AuApiClient {
  const acts = opts.acts ?? [CCA]
  return {
    getTitle: async () => CCR,
    listVersions: async (id: string) => {
      if (id === "F1996B01420") return opts.instrumentVersions ?? [version("2020-01-01", "F2020C00123", "12")]
      return opts.actVersions ? opts.actVersions() : ACT_VERSIONS
    },
    fetchJson: async (_host: string, path: string) =>
      path.includes("Search(criteria=")
        ? { "@odata.count": acts.length, value: acts }
        : AUTHORISED_BY,
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
