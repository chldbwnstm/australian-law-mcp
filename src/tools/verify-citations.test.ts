import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it } from "vitest"
import type { AuApiClient } from "../lib/api-client.js"
import { lawCache } from "../lib/cache.js"
import { ErrorCodes, LawApiError } from "../lib/errors.js"
import { parseNcx } from "../lib/ncx-parser.js"
import type { FrlTitle } from "../lib/types.js"
import { verifyCitations } from "./verify-citations.js"

const ENTRIES = parseNcx(readFileSync(new URL("./__fixtures__/cca-schedules.ncx", import.meta.url), "utf8"))
const NSW_MNC = readFileSync(new URL("../lib/sources/__fixtures__/nsw-mnc-lookup.html", import.meta.url), "utf8")
const HCA_LIST = readFileSync(new URL("../lib/sources/__fixtures__/hca-search-native-title.html", import.meta.url), "utf8")

const CCA: FrlTitle = {
  id: "C2004A00109",
  name: "Competition and Consumer Act 2010",
  collection: "Act",
  status: "InForce",
  isPrincipal: true,
  year: 1974,
  number: 51,
}

interface ClientOptions {
  tocError?: Error
  searchError?: Error
  html?: (host: string, path: string) => string
}

function client(options: ClientOptions = {}): AuApiClient {
  return {
    searchTitles: async (p: { text?: string }) => {
      if (options.searchError) throw options.searchError
      const text = (p.text ?? "").toLowerCase()
      if (text.includes("competition and consumer")) return { count: 1, titles: [CCA] }
      return { count: 0, titles: [] }
    },
    getTitle: async () => CCA,
    getToc: async () => {
      if (options.tocError) throw options.tocError
      return ENTRIES
    },
    fetchHtml: async (host: string, path: string) => {
      if (!options.html) throw new LawApiError(`no fixture for ${host}`, ErrorCodes.API_ERROR)
      return options.html(host, path)
    },
  } as unknown as AuApiClient
}

async function run(text: string, options?: ClientOptions): Promise<string> {
  const result = await verifyCitations(client(options), { text, maxCitations: 15 } as never)
  return result.content[0].text
}

beforeEach(() => lawCache.clear())

describe("verify_citations — the flagship ACL trap", () => {
  it("names the provision the writer actually meant", async () => {
    const text = await run("CCA s 18 prohibits misleading or deceptive conduct.")
    expect(text).toContain(
      "✗ CONTENT_MISMATCH: CCA s 18 is 'Meetings of Commission'; misleading or deceptive conduct is sch 2 s 18 (Australian Consumer Law)",
    )
  })

  it("marks the whole response as an error so it cannot read as a pass", async () => {
    const result = await verifyCitations(client(), {
      text: "CCA s 18 prohibits misleading or deceptive conduct.",
      maxCitations: 15,
    } as never)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("[CITATION_ERRORS_FOUND]")
  })

  it("accepts the same claim when it is cited to the schedule", async () => {
    const text = await run("ACL s 18 prohibits misleading or deceptive conduct.")
    expect(text).toContain("✓ ACL s 18 — 'Misleading or deceptive conduct'")
    expect(text).toContain("[VERIFIED]")
  })

  it("accepts a correct description of the body section", async () => {
    const text = await run("Competition and Consumer Act 2010 (Cth) s 18 (meetings of the Commission) applies.")
    expect(text).toMatch(/✓ .*s 18 — 'Meetings of Commission'/)
  })
})

describe("verify_citations — statutes", () => {
  it("reports a section the compilation does not contain, with the real range", async () => {
    const text = await run("See Competition and Consumer Act 2010 (Cth) s 4242 for the answer.")
    expect(text).toContain("✗ NOT_FOUND")
    expect(text).toContain("has no s 4242")
    expect(text).toContain("Nearest entries:")
    expect(text).toContain('write the prefix: "sch 2 s 18"')
  })

  it("inherits 'the Act' inside a paragraph", async () => {
    const text = await run(
      "The Competition and Consumer Act 2010 (Cth) s 18 governs meetings. The Act s 19 deals with Divisions.",
    )
    expect(text).toContain("Chairperson may direct Commission to sit in Divisions")
  })

  it("refuses to inherit 'that Act' across a blank line", async () => {
    const text = await run(
      "The Competition and Consumer Act 2010 (Cth) s 18 governs meetings.\n\nA quite separate topic. That Act s 19 is cited.",
    )
    expect(text).toContain("has no full citation before it in this paragraph")
    expect(text).toContain("✗ 0 cannot be right")
  })

  it("treats a missing jurisdiction as unclear, never as wrong", async () => {
    const text = await run("The accused was charged under the Crimes Act s 61.")
    expect(text).toContain("jurisdiction unclear")
    expect(text).toContain("Crimes Act 1900 (NSW)")
    expect(text).toContain("only ambiguous")
    expect(text).toContain("✗ 0 cannot be right")
  })

  it("says state legislation is out of reach rather than unverified-therefore-wrong", async () => {
    const text = await run("Crimes Act 1900 (NSW) s 61 creates the offence.")
    expect(text).toContain("not on the Federal Register")
    expect(text).toContain("legislation.nsw.gov.au")
    expect(text).toContain("✗ 0 cannot be right")
  })

  it("reports an upstream table-of-contents failure as a failure, not as absence", async () => {
    const text = await run("Competition and Consumer Act 2010 (Cth) s 18 applies.", {
      tocError: new LawApiError("frlDocs upstream server error (503)", ErrorCodes.API_ERROR),
    })
    expect(text).toContain("table of contents could not be read")
    expect(text).toContain("not evidence about the provision")
    expect(text).toContain("✗ 0 cannot be right")
  })

  it("marks a Commonwealth Act the Register does not know as a citation error", async () => {
    const text = await run("The Imaginary Widgets Act 2019 (Cth) s 5 applies.")
    expect(text).toContain("✗ NOT_FOUND")
    expect(text).toContain("very likely invented")
  })

  it("does not check a subsection-only reference and says so", async () => {
    const text = await run("Competition and Consumer Act 2010 (Cth) sub-s (2) is relevant.")
    expect(text).toContain("not listed in the table of contents")
  })
})

describe("verify_citations — cases", () => {
  it("confirms a NSW citation through the exact medium-neutral lookup", async () => {
    const text = await run("The Court applied Dela Cruz v R [2010] NSWCCA 333.", {
      html: () => NSW_MNC,
    })
    expect(text).toContain("✓ [2010] NSWCCA 333")
    expect(text).toContain("NSW Caselaw")
  })

  it("reports a blocked court as unverifiable, with the deep link", async () => {
    const text = await run("See Smith v Jones [2020] FCA 1.")
    expect(text).toContain("⚠ [2020] FCA 1")
    expect(text).toContain("NOT checked here")
    expect(text).toContain("austlii.edu.au")
    expect(text).toContain("✗ 0 cannot be right")
  })

  it("never marks a special-leave disposition as invented", async () => {
    // HCASL is not in the judgments-1998-current listing the HCA lookup walks,
    // so walking it to exhaustion says nothing about this citation.
    const text = await run("Special leave was refused: Smith v Jones [2019] HCASL 123.", {
      html: () => HCA_LIST,
    })
    expect(text).toContain("⚠ [2019] HCASL 123")
    expect(text).toContain("NOT looked up")
    expect(text).not.toContain("✗ NOT_FOUND: [2019] HCASL 123")
    expect(text).toContain("✗ 0 cannot be right")
  })

  it("sends a reported citation to LawCite rather than guessing", async () => {
    const text = await run("Mabo v Queensland (No 2) (1992) 175 CLR 1 remains authority.")
    expect(text).toContain("(1992) 175 CLR 1")
    expect(text).toContain("LawCite")
    expect(text).toContain("✗ 0 cannot be right")
  })

  it("calls an unknown court identifier unclear, not absent", async () => {
    const text = await run("The tribunal in Re Something [2020] ZZQQ 4 held otherwise.")
    expect(text).toContain("court code unclear")
    expect(text).toContain("NOT that the case does not exist")
  })

  it("finds a High Court judgment in the Court's own list", async () => {
    const text = await run("See Love v Commonwealth [2026] HCA 25.", { html: () => HCA_LIST })
    expect(text).toContain("✓ [2026] HCA 25")
  })

  it("reports absence only after the Court's complete year list was walked", async () => {
    const text = await run("See Nobody v Nobody [2026] HCA 9999.", { html: () => HCA_LIST })
    expect(text).toContain("✗ NOT_FOUND: [2026] HCA 9999")
    expect(text).toContain("complete 2026 judgment list")
  })

  it("does NOT report absence when the listing was longer than the walk", async () => {
    const text = await run("See Nobody v Nobody [2026] HCA 9999.", {
      html: () => HCA_LIST.replace("of 52 results", "of 5200 results"),
    })
    expect(text).toContain("⚠ [2026] HCA 9999")
    expect(text).toContain("longer than the 6 pages")
    expect(text).toContain("✗ 0 cannot be right")
  })

  it("warns about a medium-neutral citation that predates the court's adoption", async () => {
    const text = await run("See Mabo v Queensland [1992] HCA 23.")
    expect(text).toContain("predates that")
  })
})

describe("verify_citations — the maxCitations cap", () => {
  /** 20 blocked-court citations: extracted and counted, none of them fetched. */
  const TWENTY_CASES = Array.from({ length: 20 }, (_, index) => `See Party v Party [2020] FCA ${index + 1}.`).join(" ")

  it("says how many citations were found as well as how many were checked", async () => {
    const text = await run(TWENTY_CASES)
    expect(text).toContain("Case citations: 15 checked of 20 found")
  })

  it("refuses to read a capped check as a clean bill of health", async () => {
    const text = await run(TWENTY_CASES)
    expect(text).not.toContain("[VERIFIED] Citation check")
    expect(text).toContain("[PARTIALLY_VERIFIED]")
    expect(text).toContain("NOT CHECKED: 5 citation(s)")
    expect(text).toContain("maxCitations=15")
    expect(text).toContain("covers PART of the text only")
  })

  it("lists the citations it never looked at, so a fabricated one is still visible", async () => {
    // The 16th citation is the one the cap drops; before it was listed, a
    // hallucination past the cap was reported as though the text had passed.
    const text = await run(TWENTY_CASES)
    expect(text).toContain("⚠ [2020] FCA 16 — NOT checked: past this call's maxCitations limit (15).")
    expect(text).toContain("[2020] FCA 20")
  })

  it("counts statute citations the same way", async () => {
    const statutes = Array.from(
      { length: 18 },
      (_, index) => `Competition and Consumer Act 2010 (Cth) s ${index + 1} applies.`,
    ).join("\n\n")
    const text = await run(statutes)
    expect(text).toContain("Statute citations: 15 checked of 18 found")
    expect(text).toContain("NOT CHECKED: 3 citation(s)")
  })

  it("still reads as verified when nothing was dropped", async () => {
    const text = await run("ACL s 18 prohibits misleading or deceptive conduct.")
    expect(text).toContain("[VERIFIED]")
    expect(text).not.toContain("NOT CHECKED")
  })
})

describe("verify_citations — no citations", () => {
  it("refuses to read 'nothing found' as 'nothing wrong'", async () => {
    const text = await run("The parties agreed to settle the matter without admission of liability.")
    expect(text).toContain("[NO_CITATIONS_FOUND]")
    expect(text).toContain("NOT a clean bill of health")
  })
})
