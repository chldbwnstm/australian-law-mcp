import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it } from "vitest"
import type { AuApiClient } from "../lib/api-client.js"
import { lawCache } from "../lib/cache.js"
import { ErrorCodes, LawApiError } from "../lib/errors.js"
import { DEFAULT_EXECUTION_LIMITS, ExecutionLimitError, RequestExecutionBudget } from "../lib/execution-limits.js"
import { parseNcx } from "../lib/ncx-parser.js"
import { runWithRequestContext } from "../lib/session-state.js"
import type { FrlTitle } from "../lib/types.js"
import {
  GetBatchProvisionsSchema,
  MAX_BATCH_LAWS,
  MAX_BATCH_PROVISIONS,
  MAX_PROVISIONS_PER_LAW,
  classifyLoss,
  getBatchProvisions,
} from "./batch-provisions.js"

const ENTRIES = parseNcx(readFileSync(new URL("./__fixtures__/cca-schedules.ncx", import.meta.url), "utf8"))
const VOL1 = readFileSync(new URL("../lib/__fixtures__/cca-vol1-slice.html", import.meta.url), "utf8")
const VOL4 = readFileSync(new URL("./__fixtures__/cca-vol4-schedule2.html", import.meta.url), "utf8")

const CCA: FrlTitle = { id: "C2004A00109", name: "Competition and Consumer Act 2010", collection: "Act", status: "InForce", isPrincipal: true }

function client(counters = { toc: 0, volumes: [] as number[] }): { api: AuApiClient; counters: typeof counters } {
  const api = {
    getTitle: async () => CCA,
    // The alias path: "ACL" is searched as "Competition and Consumer Act 2010".
    searchTitles: async () => ({ count: 1, titles: [CCA] }),
    getToc: async () => {
      counters.toc++
      return ENTRIES
    },
    getVolumeHtml: async (_id: string, volume: number) => {
      counters.volumes.push(volume)
      return volume === 1 ? VOL1 : VOL4
    },
  } as unknown as AuApiClient
  return { api, counters }
}

beforeEach(() => lawCache.clear())

describe("get_batch_provisions cost", () => {
  it("fetches the table of contents once per title, not once per provision", async () => {
    const { api, counters } = client()
    await getBatchProvisions(api, {
      registerId: "C2004A00109",
      provisions: ["s 18", "s 19", "s 17A"],
      maxCharsPerProvision: 2500,
    } as never)
    expect(counters.toc).toBe(1)
  })

  it("fetches each volume once even when several provisions share it", async () => {
    const { api, counters } = client()
    const text = (
      await getBatchProvisions(api, {
        registerId: "C2004A00109",
        provisions: ["s 18", "s 19", "sch 2 s 18"],
        maxCharsPerProvision: 2500,
      } as never)
    ).content[0].text
    expect(counters.volumes.filter((volume) => volume === 1)).toHaveLength(1)
    expect(counters.volumes.filter((volume) => volume === 4)).toHaveLength(1)
    expect(text).toContain("(volumes read for this title: 2)")
  })
})

describe("get_batch_provisions results", () => {
  it("keeps the body and the schedule provision apart", async () => {
    const { api } = client()
    const text = (
      await getBatchProvisions(api, {
        registerId: "C2004A00109",
        provisions: ["s 18", "sch 2 s 18"],
        maxCharsPerProvision: 2500,
      } as never)
    ).content[0].text
    expect(text).toContain("Meetings of Commission")
    expect(text).toContain("Misleading or deceptive conduct")
  })

  it("lists misses explicitly and counts them, rather than dropping them", async () => {
    const { api } = client()
    const result = await getBatchProvisions(api, {
      registerId: "C2004A00109",
      provisions: ["s 18", "s 9999", "not a reference"],
      maxCharsPerProvision: 2500,
    } as never)
    const text = result.content[0].text
    expect(text).toContain("3 requested, 1 retrieved, 2 not found")
    expect(text).toContain("✗ s 9999")
    expect(text).toContain("not a recognisable provision reference")
    expect(text).toContain("Do not fill the gaps from memory")
    // Nothing upstream failed here: these are real table-of-contents misses,
    // so the upstream label must not appear.
    expect(text).not.toContain("[UPSTREAM_NO_DATA]")
    expect(result.isError).toBeFalsy()
  })

  it("marks a title that could not be resolved without abandoning the rest", async () => {
    // What `getTitle` really raises when the Register answered and its Titles
    // collection had no such row: authoritative absence.
    const api = {
      getTitle: async (id: string) => {
        if (id === "C9999X99999") {
          throw new LawApiError(`FRL reports no title with id ${id}`, ErrorCodes.NOT_FOUND)
        }
        return CCA
      },
      getToc: async () => ENTRIES,
      getVolumeHtml: async () => VOL1,
    } as unknown as AuApiClient
    const result = await getBatchProvisions(api, {
      laws: [
        { registerId: "C9999X99999", provisions: ["s 1"] },
        { registerId: "C2004A00109", provisions: ["s 18"] },
      ],
      maxCharsPerProvision: 2500,
    } as never)
    const text = result.content[0].text
    expect(text).toContain("[NOT_FOUND]")
    expect(text).toContain("Meetings of Commission")
    // The Register said so, so this one really is an absence: no upstream
    // label, and a batch that kept its other title is not an error.
    expect(text).not.toContain("[UPSTREAM_NO_DATA]")
    expect(result.isError).toBeFalsy()
  })

  it("a title lookup that failed upstream is not a list of absences", async () => {
    // The counter on this path was hard-coded to 0, so an outage in the title
    // lookup printed "3 requested, 0 retrieved, 3 not found" with no label and
    // no flag — and `chains.ts` secOrSkip rendered the block as data instead
    // of [NOT RETRIEVED].
    const api = {
      getTitle: async () => {
        throw new LawApiError("frlTitles upstream server error (500)", ErrorCodes.API_ERROR)
      },
      searchTitles: async () => {
        throw new LawApiError("frlTitles upstream server error (500)", ErrorCodes.API_ERROR)
      },
      getToc: async () => ENTRIES,
      getVolumeHtml: async () => VOL1,
    } as unknown as AuApiClient

    const result = await getBatchProvisions(api, {
      registerId: "C2004A00109",
      provisions: ["s 18", "s 45", "sch 2 s 18"],
      maxCharsPerProvision: 2500,
    } as never)
    const text = result.content[0].text

    expect(result.isError).toBe(true)
    expect(text).toContain("[UPSTREAM_NO_DATA] 3 of them failed")
    expect(text).toContain("not evidence the provision is absent")
    expect(text).toContain("[UPSTREAM_NO_DATA] frlTitles upstream server error (500)")
    expect(text).not.toContain("[NOT_FOUND]")
  })

  it("counts a table of contents that would not load as an upstream loss too", async () => {
    // The title resolved; the compilation's TOC did not. Same block, same
    // hard-coded zero.
    const api = {
      getTitle: async () => CCA,
      getToc: async () => {
        throw new Error("frlDocs upstream server error (500)")
      },
      getVolumeHtml: async () => VOL1,
    } as unknown as AuApiClient

    const result = await getBatchProvisions(api, {
      registerId: "C2004A00109",
      provisions: ["s 18"],
      maxCharsPerProvision: 2500,
    } as never)

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("[UPSTREAM_NO_DATA] 1 of them failed")
  })

  it("does not label an ambiguous query as an upstream failure", async () => {
    // "Evidence Act" names Acts in several jurisdictions. Nothing was asked of
    // the Register, so neither absence nor "retry shortly" is true.
    const { api } = client()
    const result = await getBatchProvisions(api, {
      query: "Evidence Act",
      provisions: ["s 1"],
      maxCharsPerProvision: 2500,
    } as never)
    const text = result.content[0].text

    expect(text).toContain("[INVALID_PARAMETER]")
    expect(text).not.toContain("[UPSTREAM_NO_DATA]")
    expect(result.isError).toBeFalsy()
  })

  it("marks the provisions of a dead volume and keeps everything already retrieved", async () => {
    // The CCA's body is volume 1 and schedule 2 is volume 4; only the second
    // fails. Before the fix the exception escaped runTask and the whole call
    // became one error, discarding the volume-1 text and the budget spent on it.
    const api = {
      getTitle: async () => CCA,
      getToc: async () => ENTRIES,
      getVolumeHtml: async (_id: string, volume: number) => {
        if (volume === 4) throw new Error("frlDocs upstream server error (500)")
        return VOL1
      },
    } as unknown as AuApiClient

    const result = await getBatchProvisions(api, {
      registerId: "C2004A00109",
      provisions: ["s 18", "s 19", "sch 2 s 18"],
      maxCharsPerProvision: 2500,
    } as never)
    const text = result.content[0].text

    expect(result.isError).toBeFalsy()
    expect(text).toContain("3 requested, 2 retrieved, 1 not found")
    expect(text).toContain("Meetings of Commission")
    expect(text).toContain("could not be read: frlDocs upstream server error (500)")
    // A failed volume is not a missing provision — the reason travels with it.
    expect(text).not.toContain("not in this compilation's table of contents")
    // …and the summary itself says which kind of gap this is, so a partial
    // batch is distinguishable from one where everything was retrieved.
    expect(text).toContain("[UPSTREAM_NO_DATA] 1 of them failed")
    expect(text).toContain("not evidence the provision is absent")
  })

  it("a batch that lost everything to an upstream failure is an error, not a list of absences", async () => {
    // Swallowing the volume throw kept the partial data but also dropped the
    // response's error flag; a chain then rendered an outage as a completed
    // section instead of [NOT RETRIEVED].
    const api = {
      getTitle: async () => CCA,
      getToc: async () => ENTRIES,
      getVolumeHtml: async () => {
        throw new Error("frlDocs upstream server error (500)")
      },
    } as unknown as AuApiClient

    const result = await getBatchProvisions(api, {
      registerId: "C2004A00109",
      provisions: ["s 18", "sch 2 s 18"],
      maxCharsPerProvision: 2500,
    } as never)

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("[UPSTREAM_NO_DATA] 2 of them failed")
  })

  it("still keeps its data when only some provisions were lost upstream", async () => {
    const api = {
      getTitle: async () => CCA,
      getToc: async () => ENTRIES,
      getVolumeHtml: async (_id: string, volume: number) => {
        if (volume === 4) throw new Error("frlDocs upstream server error (500)")
        return VOL1
      },
    } as unknown as AuApiClient

    const result = await getBatchProvisions(api, {
      registerId: "C2004A00109",
      provisions: ["s 18", "sch 2 s 18"],
      maxCharsPerProvision: 2500,
    } as never)

    // A partial answer is an answer: the flag stays clear so a chain prints
    // the text it did get, and the label carries the warning.
    expect(result.isError).toBeFalsy()
    expect(result.content[0].text).toContain("Meetings of Commission")
    expect(result.content[0].text).toContain("[UPSTREAM_NO_DATA]")
  })

  it("does not re-fetch a volume that already failed once in the same batch", async () => {
    // Thirty sections of one dead volume must cost one attempt, not thirty.
    const attempts: number[] = []
    const api = {
      getTitle: async () => CCA,
      getToc: async () => ENTRIES,
      getVolumeHtml: async (_id: string, volume: number) => {
        attempts.push(volume)
        throw new Error("frlDocs upstream server error (500)")
      },
    } as unknown as AuApiClient

    const text = (
      await getBatchProvisions(api, {
        registerId: "C2004A00109",
        provisions: ["s 18", "s 19", "s 17A"],
        maxCharsPerProvision: 2500,
      } as never)
    ).content[0].text

    expect(attempts).toEqual([1])
    expect(text).toContain("3 requested, 0 retrieved, 3 not found")
  })

  it("shortens a long provision rather than letting it crowd out the others", async () => {
    const { api } = client()
    const text = (
      await getBatchProvisions(api, {
        registerId: "C2004A00109",
        provisions: ["s 18"],
        maxCharsPerProvision: 200,
      } as never)
    ).content[0].text
    expect(text).toContain("(provision shortened to 200 characters)")
  })
})

describe("get_batch_provisions applies the schedule its alias names", () => {
  // Worse than get_law_text's version of the same trap: this tool prints no
  // alias note at all, so the body's s 18 came back with nothing to catch it.
  const byQuery = (query: string, provisions: string[]) =>
    getBatchProvisions(client().api, { query, provisions, maxCharsPerProvision: 2500 } as never)

  it('query "ACL" + "s 18" returns the ACL section, not CCA s 18', async () => {
    const text = (await byQuery("ACL", ["s 18"])).content[0].text
    expect(text).toContain("sch 2 s 18 —")
    expect(text).toContain("Misleading or deceptive conduct")
    // "quorum" appears only in the body provision (18 Meetings of Commission).
    expect(text).not.toContain("quorum")
    expect(text).toContain("1 requested, 1 retrieved, 0 not found")
  })

  it("says it read the reference inside the schedule", async () => {
    const text = (await byQuery("ACL", ["s 18"])).content[0].text
    expect(text).toContain('Alias "ACL" names sch 2 of this Act')
  })

  it("does not double-prefix a schedule the caller wrote out", async () => {
    const text = (await byQuery("ACL", ["sch 2 s 18"])).content[0].text
    expect(text).not.toContain("sch 2 sch 2")
    expect(text).toContain("Misleading or deceptive conduct")
    expect(text).toContain("1 requested, 1 retrieved, 0 not found")
  })

  it("leaves an alias that names no schedule alone", async () => {
    const text = (await byQuery("CCA", ["s 18"])).content[0].text
    expect(text).toContain("Meetings of Commission")
    expect(text).not.toContain("names sch")
  })
})

describe("get_batch_provisions limits", () => {
  it("caps the total number of provisions across titles", () => {
    const laws = Array.from({ length: 5 }, () => ({
      registerId: "C2004A00109",
      provisions: Array.from({ length: 30 }, (_, index) => `s ${index + 1}`),
    }))
    const parsed = GetBatchProvisionsSchema.safeParse({ laws })
    expect(parsed.success).toBe(false)
    expect(JSON.stringify(parsed)).toContain(String(MAX_BATCH_PROVISIONS))
  })

  it("caps provisions per title and titles per call", () => {
    expect(
      GetBatchProvisionsSchema.safeParse({
        registerId: "C2004A00109",
        provisions: Array.from({ length: MAX_PROVISIONS_PER_LAW + 1 }, (_, i) => `s ${i}`),
      }).success,
    ).toBe(false)
    expect(
      GetBatchProvisionsSchema.safeParse({
        laws: Array.from({ length: MAX_BATCH_LAWS + 1 }, () => ({ registerId: "C2004A00109", provisions: ["s 1"] })),
      }).success,
    ).toBe(false)
  })

  it("requires provisions in the single-title form", () => {
    expect(GetBatchProvisionsSchema.safeParse({ registerId: "C2004A00109" }).success).toBe(false)
  })
})

// ── a spent budget is this server's arithmetic, not the Register's behaviour ─

/** The exact error `RequestExecutionBudget` raises when the attempt budget runs out. */
const budgetError = () =>
  new ExecutionLimitError(`Request upstream work budget exceeded (max ${DEFAULT_EXECUTION_LIMITS.maxUpstreamRequests} attempts).`)

/** The head line's upstream sentence, verbatim — the one that told the caller to retry. */
const RETRY_ADVICE = "Retry before concluding anything"

describe("classifyLoss keeps the four causes of a missing provision apart", () => {
  // The enumeration. Every site in `runTask` that turns an exception into a
  // missing provision routes through this one function, so a new site cannot
  // classify the same exception differently — which is exactly how a spent
  // budget came to be reported as the Federal Register's failure.
  const CASES: Array<[string, unknown, string, string]> = [
    ["a spent attempt budget", budgetError(), ErrorCodes.INVALID_PARAM, "budget"],
    [
      "a spent body budget",
      new ExecutionLimitError("Request upstream response-body budget exceeded (max 3145728 bytes)."),
      ErrorCodes.INVALID_PARAM,
      "budget",
    ],
    ["the Register's own absence", new LawApiError("FRL reports no title with id X", ErrorCodes.NOT_FOUND), "NOT_FOUND", "absent"],
    [
      "an under-specified call",
      new LawApiError("'Evidence Act' is ambiguous", ErrorCodes.INVALID_PARAM),
      ErrorCodes.INVALID_PARAM,
      "invalid",
    ],
    ["an upstream 500", new LawApiError("frlDocs upstream server error (500)", ErrorCodes.API_ERROR), ErrorCodes.UPSTREAM_NO_DATA, "upstream"],
    ["a bare transport error", new Error("socket hang up"), ErrorCodes.UPSTREAM_NO_DATA, "upstream"],
  ]

  it.each(CASES)("%s", (_name, error, label, kind) => {
    expect(classifyLoss(error)).toEqual({ label, kind })
  })

  it("covers every kind the module declares", () => {
    expect(new Set(CASES.map(([, , , kind]) => kind))).toEqual(new Set(["budget", "absent", "invalid", "upstream"]))
  })
})

describe("get_batch_provisions attributes a spent budget to the budget", () => {
  /**
   * Reproduced before the fix, at each of the three sites below: the head line
   * read "[UPSTREAM_NO_DATA] N of them failed because the Federal Register did
   * not hand over the title, its table of contents or the volume text … Retry
   * before concluding anything", while the Register was healthy and every miss
   * read "Request upstream work budget exceeded (max 48 attempts)". A model
   * following that instruction re-issues the identical call for ever.
   */
  function expectsBudgetNotUpstream(text: string): void {
    expect(text).toContain(`[${ErrorCodes.INVALID_PARAM}]`)
    expect(text).toContain("this request's own upstream work budget ran out")
    expect(text).toContain("a limit inside this server, not a fact about the Federal Register")
    expect(text).toContain("Retrying this call unchanged will fail in exactly the same place")
    expect(text).toContain("split it into smaller calls (fewer provisions, or fewer titles)")
    expect(text).not.toContain(RETRY_ADVICE)
    expect(text).not.toContain("the Federal Register did not hand over")
  }

  it("when the title lookup is what the budget stopped", async () => {
    const api = {
      getTitle: async () => {
        throw budgetError()
      },
      searchTitles: async () => {
        throw budgetError()
      },
      getToc: async () => ENTRIES,
      getVolumeHtml: async () => VOL1,
    } as unknown as AuApiClient

    const result = await getBatchProvisions(api, {
      registerId: "C2004A00109",
      provisions: ["s 18", "s 45"],
      maxCharsPerProvision: 2500,
    } as never)
    const text = result.content[0].text

    expectsBudgetNotUpstream(text)
    expect(text).toContain("2 of them were never requested")
    // Nothing was retrieved, so a chain must still see this as a failed call.
    expect(result.isError).toBe(true)
  })

  it("when the volume fetch is what the budget stopped", async () => {
    const api = {
      getTitle: async () => CCA,
      getToc: async () => ENTRIES,
      getVolumeHtml: async () => {
        throw budgetError()
      },
    } as unknown as AuApiClient

    const result = await getBatchProvisions(api, {
      registerId: "C2004A00109",
      provisions: ["s 18"],
      maxCharsPerProvision: 2500,
    } as never)

    expectsBudgetNotUpstream(result.content[0].text)
    expect(result.isError).toBe(true)
  })

  it("when a remembered volume failure is replayed for a second provision", async () => {
    // The third site: the volume is fetched once and its error cached, so
    // provisions two and three read the remembered message. Replaying it must
    // not relabel a spent budget as an upstream outage.
    const attempts: number[] = []
    const api = {
      getTitle: async () => CCA,
      getToc: async () => ENTRIES,
      getVolumeHtml: async (_id: string, volume: number) => {
        attempts.push(volume)
        throw budgetError()
      },
    } as unknown as AuApiClient

    const result = await getBatchProvisions(api, {
      registerId: "C2004A00109",
      provisions: ["s 18", "s 19", "s 17A"],
      maxCharsPerProvision: 2500,
    } as never)
    const text = result.content[0].text

    expect(attempts).toEqual([1])
    expectsBudgetNotUpstream(text)
    expect(text).toContain("3 of them were never requested")
  })

  it("keeps a genuine upstream loss and a budget loss in separate sentences", async () => {
    // The CCA's body is volume 1 and schedule 2 is volume 4: one dies upstream,
    // the other on the budget. Two causes, two remedies, two labels.
    const api = {
      getTitle: async () => CCA,
      getToc: async () => ENTRIES,
      getVolumeHtml: async (_id: string, volume: number) => {
        if (volume === 1) throw new Error("frlDocs upstream server error (500)")
        throw budgetError()
      },
    } as unknown as AuApiClient

    const result = await getBatchProvisions(api, {
      registerId: "C2004A00109",
      provisions: ["s 18", "sch 2 s 18"],
      maxCharsPerProvision: 2500,
    } as never)
    const text = result.content[0].text

    expect(text).toContain(`[${ErrorCodes.UPSTREAM_NO_DATA}] 1 of them failed`)
    expect(text).toContain(RETRY_ADVICE)
    expect(text).toContain(`[${ErrorCodes.INVALID_PARAM}] 1 of them were never requested`)
    expect(text).toContain("Retrying this call unchanged will fail in exactly the same place")
    expect(result.isError).toBe(true)
  })

  it("quotes the budget's own message, so an operator can see which limit bound", async () => {
    const api = {
      getTitle: async () => CCA,
      getToc: async () => ENTRIES,
      getVolumeHtml: async () => {
        throw new ExecutionLimitError("Request upstream response-body budget exceeded (max 3145728 bytes).")
      },
    } as unknown as AuApiClient

    const text = (
      await getBatchProvisions(api, {
        registerId: "C2004A00109",
        provisions: ["s 18"],
        maxCharsPerProvision: 2500,
      } as never)
    ).content[0].text

    expect(text).toContain("Request upstream response-body budget exceeded (max 3145728 bytes).")
    expect(text).toContain("MCP_MAX_TOTAL_UPSTREAM_BODY_BYTES")
  })

  it("the schema-maximum call under a real budget reports the budget, not the Register", async () => {
    // The reported scenario, end to end: MAX_BATCH_LAWS titles × one provision,
    // through a real `RequestExecutionBudget` that a healthy client charges one
    // attempt per call. The Register never fails; the budget does.
    const budget = new RequestExecutionBudget({ ...DEFAULT_EXECUTION_LIMITS, maxUpstreamRequests: 8 })
    const api = {
      getTitle: async () => {
        budget.consumeUpstreamRequest()
        return CCA
      },
      getToc: async () => {
        budget.consumeUpstreamRequest()
        return ENTRIES
      },
      getVolumeHtml: async () => {
        budget.consumeUpstreamRequest()
        return VOL1
      },
    } as unknown as AuApiClient

    const result = await runWithRequestContext({ budget }, () =>
      getBatchProvisions(api, {
        laws: Array.from({ length: MAX_BATCH_LAWS }, () => ({ registerId: "C2004A00109", provisions: ["s 18"] })),
        maxCharsPerProvision: 2500,
      } as never),
    )
    const text = result.content[0].text

    expect(text).toContain("Request upstream work budget exceeded (max 8 attempts).")
    expect(text).toContain(`[${ErrorCodes.INVALID_PARAM}]`)
    expect(text).not.toContain(RETRY_ADVICE)
    // Some titles were served before the budget ran out: a partial answer is
    // still an answer, and the label carries the reason for the rest.
    expect(text).toContain("Meetings of Commission")
    expect(result.isError).toBeFalsy()
  })
})
