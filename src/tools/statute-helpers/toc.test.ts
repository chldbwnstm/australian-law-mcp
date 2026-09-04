import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { beforeEach, describe, expect, it } from "vitest"
import type { AuApiClient } from "../../lib/api-client.js"
import { lawCache } from "../../lib/cache.js"
import { ErrorCodes, LawApiError, formatToolError } from "../../lib/errors.js"
import { parseNcx } from "../../lib/ncx-parser.js"
import { parseSectionRef } from "../../lib/section-ref.js"
import type { FrlTitle, ToolResponse } from "../../lib/types.js"
import { getHistoricalLaw } from "../historical-law.js"
import { getInstrumentProvisions } from "../law-linkage.js"
import { getLawText } from "../law-text.js"
import { getLawTree } from "../law-tree.js"
import { getProvisionHistory } from "../provision-history.js"
import { locate, requireRef, sliceSubtree } from "./toc.js"

/*
 * Miniature of the *Commonwealth of Australia Constitution Act* TOC
 * (C2004Q00685) — the Imperial Act's covering clauses ss 1–9 under the
 * document root, the Constitution's own ss 1–9 under Chapter I. Labels and
 * anchors are verbatim from the live NCX read 2026-09-04; the full-size
 * version of this fixture and the reasoning live in
 * `src/lib/provision-slicer.test.ts`.
 */
const nav = (label: string, anchor: string | null, children = ""): string =>
  `<navPoint id="${anchor ?? "root"}" playOrder="0"><navLabel><text>${label}</text></navLabel>` +
  `<content src="document_1/document_1.html${anchor ? `#${anchor}` : ""}" />${children}</navPoint>`

const CONSTITUTION = parseNcx(
  "<ncx><navMap>" +
    nav(
      "Commonwealth of Australia Constitution Act - [Other]",
      null,
      nav("7.&#xa0; Repeal of Federal Council Act.", "_Toc29462588") +
        nav(
          "Chapter I.&#8212;The Parliament.",
          "_Toc29462592",
          nav("Part II.&#8212;The Senate.", "_Toc29462600") +
            nav("7.&#xa0; The Senate.", "_Toc29462601") +
            nav("8.&#xa0; Qualification of electors.", "_Toc29462602"),
        ),
    ) +
    "</navMap></ncx>",
)

const CONSTITUTION_HTML =
  "<html><body>" +
  '<p class="ActHead5"><a id="_Toc29462588">7 Repeal of Federal Council Act.</a></p>' +
  '<p class="subsection">The Federal Council of Australasia Act 1885 is hereby repealed.</p>' +
  '<p class="ActHead5"><a id="_Toc29462601">7 The Senate.</a></p>' +
  '<p class="subsection">The Senate shall be composed of senators for each State.</p>' +
  '<p class="ActHead5"><a id="_Toc29462602">8 Qualification of electors.</a></p>' +
  "</body></html>"

const ref = (input: string) => parseSectionRef(input)!

describe("locate — the tool-side entry to navPoint resolution", () => {
  it("serves the Constitution's own s 7, and keeps the covering clause at cl 7", () => {
    expect(locate(ref("s 7"), CONSTITUTION)?.label).toBe("7. The Senate.")
    expect(locate(ref("cl 7"), CONSTITUTION)?.label).toBe("7. Repeal of Federal Council Act.")
  })
})

describe("sliceSubtree", () => {
  it("names the twice-used number in the text it serves", () => {
    const text = sliceSubtree(CONSTITUTION_HTML, CONSTITUTION, locate(ref("s 7"), CONSTITUTION)!)!
    expect(text.startsWith('Note: this compilation numbers "7" more than once')).toBe(true)
    expect(text).toContain('Ask for it as "cl 7".')
    expect(text).toContain("The Senate shall be composed of senators")
  })

  it("says nothing extra when the number is used once", () => {
    const text = sliceSubtree(CONSTITUTION_HTML, CONSTITUTION, locate(ref("s 8"), CONSTITUTION)!)!
    expect(text).not.toContain("more than once")
  })
})

/*
 * ── An unparseable `provision` is a parameter problem, not an upstream one ──
 *
 * `requireRef` used to throw a plain `Error`, which `formatToolError` has no
 * code to read and so labels `[EXTERNAL_API_ERROR]`: an upstream-failure label
 * for a string this server rejected locally, telling the caller to retry
 * something that can never succeed.
 */
const UNPARSEABLE = "Application of amendments"

describe("requireRef", () => {
  it("throws a LawApiError carrying INVALID_PARAMETER", () => {
    let thrown: unknown
    try {
      requireRef(UNPARSEABLE)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(LawApiError)
    expect((thrown as LawApiError).code).toBe(ErrorCodes.INVALID_PARAM)
    expect((thrown as LawApiError).message).toContain("Not a recognisable provision reference")
  })

  it("renders as [INVALID_PARAMETER], never as an upstream failure", () => {
    let thrown: unknown
    try {
      requireRef("s 134(1) of sch 2")
    } catch (error) {
      thrown = error
    }
    const text = formatToolError(thrown, "get_law_text").content[0].text
    expect(text.startsWith("[INVALID_PARAMETER]")).toBe(true)
    expect(text).not.toContain("EXTERNAL_API_ERROR")
    // The accepted forms have to be in the answer, or the caller cannot recover.
    expect(text).toContain('"sch 2 s 18"')
    expect(text).toContain('"cl 7"')
  })

  it("still parses everything it accepted before", () => {
    expect(requireRef("s 18").number).toBe("18")
    expect(requireRef("sch 2 s 18").schedule).toBe("2")
    expect(requireRef("pt IVA").kind).toBe("part")
  })
})

const TITLE: FrlTitle = {
  id: "C2004A00109",
  name: "Competition and Consumer Act 2010",
  collection: "Act",
  status: "InForce",
  isPrincipal: true,
  isInForce: true,
}

function stubClient(): AuApiClient {
  return {
    getTitle: async () => TITLE,
    searchTitles: async () => ({ count: 1, titles: [TITLE] }),
    getToc: async () => CONSTITUTION,
    findVersion: async () => ({ registerId: "C2004A00109", start: "2020-01-01" }),
    getVolumeHtml: async () => CONSTITUTION_HTML,
    getProvision: async () => {
      throw new Error("no tool under test may reach upstream text with an unparseable provision")
    },
  } as unknown as AuApiClient
}

/*
 * Every tool that hands a caller-supplied string to `requireRef`, enumerated
 * and driven. The list is checked against the source tree below, so a new
 * consumer cannot quietly go back to answering `[EXTERNAL_API_ERROR]`.
 */
const CONSUMERS: ReadonlyArray<[module: string, tool: string, run: () => Promise<ToolResponse>]> = [
  ["law-text.ts", "get_law_text", () =>
    getLawText(stubClient(), { registerId: TITLE.id, provision: UNPARSEABLE, maxChars: 20000 } as never)],
  ["provision-history.ts", "get_provision_history", () =>
    getProvisionHistory(stubClient(), {
      registerId: TITLE.id,
      provision: UNPARSEABLE,
      resolveActs: false,
    } as never)],
  ["law-tree.ts", "get_law_tree", () =>
    getLawTree(stubClient(), { registerId: TITLE.id, from: UNPARSEABLE, depth: 2, limit: 150 } as never)],
  ["law-linkage.ts", "get_instrument_provisions", () =>
    getInstrumentProvisions(stubClient(), { registerId: TITLE.id, provision: UNPARSEABLE, depth: 3 } as never)],
  ["historical-law.ts", "get_historical_law", () =>
    getHistoricalLaw(stubClient(), {
      registerId: TITLE.id,
      date: "asmade",
      provision: UNPARSEABLE,
      maxChars: 20000,
    } as never)],
]

describe("an unparseable provision is labelled locally by every tool that takes one", () => {
  beforeEach(() => lawCache.clear())

  it.each(CONSUMERS)("%s (%s)", async (_module, _tool, run) => {
    const text = (await run()).content[0].text
    expect(text).toContain("[INVALID_PARAMETER]")
    expect(text).not.toContain("[EXTERNAL_API_ERROR]")
    expect(text).toContain("Not a recognisable provision reference")
  })

  it("covers every module that calls requireRef", () => {
    const SRC = fileURLToPath(new URL("../../", import.meta.url))
    const files: string[] = []
    const walk = (dir: string) => {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, item.name)
        if (item.isDirectory()) walk(path)
        else if (item.name.endsWith(".ts") && !item.name.endsWith(".test.ts")) files.push(path)
      }
    }
    walk(SRC)

    const callers = files
      .filter((path) => {
        const source = readFileSync(path, "utf8")
        return /import\s*{[^}]*\brequireRef\b/.test(source) && !path.endsWith(join("statute-helpers", "toc.ts"))
      })
      .map((path) => relative(SRC, path).replaceAll("\\", "/").split("/").pop()!)
      .sort()

    expect(callers).toEqual([...CONSUMERS.map(([module]) => module)].sort())
  })
})
