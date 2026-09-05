/**
 * `docs/API.md` checked against the code it documents, for the two decision
 * tools.
 *
 * A parameter table is read by models that cannot read the source, and a
 * documented key the dispatcher drops — or that the target domain's schema
 * never declares — is worse than an undocumented one: the caller believes it
 * asked for something. `options.asAt` on `search_decisions(domain="tax_rulings")`
 * is the case this file was written for. Zod strips it, `searchRulings` never
 * reads it, the ATO answers with today's rulings, and the response carries no
 * hint that the point-in-time request went nowhere.
 *
 * So the oracle here is each domain's **own** Zod schema: the keys it declares
 * are the keys its handler reads. `docs/API.md` must name exactly those, for
 * all eighteen domains, on both tools.
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import type { z } from "zod"

import {
  DECISION_DOMAINS,
  GetDecisionTextSchema,
  SEARCH_SCHEMAS,
  SearchDecisionsSchema,
  getDecisionText,
} from "./tools/unified-decisions.js"
import { GetCaseTextSchema } from "./tools/precedents.js"
import { GetConstitutionalSchema } from "./tools/constitutional-decisions.js"
import { GetAdminAppealSchema } from "./tools/admin-appeals.js"
import { GetTaxTribunalSchema } from "./tools/tax-tribunal-decisions.js"
import { GetRulingTextSchema } from "./tools/rulings.js"
import {
  GetCompetitionSchema,
  GetIntegritySchema,
  GetPrivacySchema,
  GetPublicServiceSchema,
  GetWorkplaceSchema,
} from "./tools/committee-decisions.js"
import { GetRegisteredInstrumentSchema } from "./tools/institutional-rules.js"
import { GetTreatyTextSchema } from "./tools/treaties.js"
import { GetExplanatoryTextSchema } from "./tools/explanatory.js"
import { GetStateLawTextSchema } from "./tools/state-law.js"

const API_MD = readFileSync(new URL("../docs/API.md", import.meta.url), "utf8")

/** The slice of the document that belongs to one tool's heading. */
function section(start: string, end: string): string {
  const from = API_MD.indexOf(start)
  if (from < 0) throw new Error(`docs/API.md has no ${start} heading`)
  const to = API_MD.indexOf(end, from + start.length)
  if (to < 0) throw new Error(`docs/API.md has no ${end} heading after ${start}`)
  return API_MD.slice(from, to)
}

const SEARCH_SECTION = section("#### `search_decisions`", "#### `get_decision_text`")
const GET_SECTION = section("#### `get_decision_text`", "### Meta")

/**
 * A documented claim: one or more backticked domain names followed by a
 * `{…}` key list. Matches the per-domain table rows and any inline
 * ``` `state_law` | `university_rules`: `{jurisdiction}` ``` shorthand, so the
 * check does not depend on how the row happens to be laid out. Separators stay
 * on one line, so a claim can never run from one table row into the next.
 */
const CLAIM = new RegExp(
  `((?:\`(?:${DECISION_DOMAINS.join("|")})\`(?:[ \\t·,]|\\\\?\\|)*)+)[ \\t:]*\`?\\{([^}\\n]*)\\}`,
  "g",
)

interface Claim {
  domains: string[]
  keys: string[]
}

function parseClaims(text: string): Claim[] {
  return [...text.matchAll(CLAIM)].map((match) => ({
    domains: [...match[1].matchAll(/`([a-z_]+)`/g)].map((name) => name[1]),
    keys: match[2]
      .split(/[,·]/)
      .map((key) => key.trim().replace(/`/g, ""))
      .filter((key) => key.length > 0),
  }))
}

/** domain → the option keys the document says that domain honours. */
function documentedOptions(claims: Claim[]): Map<string, string[]> {
  const table = new Map<string, string[]>()
  for (const claim of claims) {
    for (const domain of claim.domains) {
      if (table.has(domain)) throw new Error(`docs/API.md gives ${domain} two options rows`)
      table.set(domain, claim.keys)
    }
  }
  return table
}

function shapeKeys(schema: z.ZodType): string[] {
  const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape
  if (!shape) throw new Error("expected a z.object schema")
  return Object.keys(shape)
}

/**
 * `GET_HANDLERS` is private to `unified-decisions.ts`, so the schema of the
 * tool each domain lands on is mirrored here — one entry per handler in that
 * map, named after it. A domain added there without a row here fails the
 * coverage assertion below rather than going unchecked.
 */
const GET_SCHEMAS: Record<string, z.ZodType> = {
  cases: GetCaseTextSchema,
  constitutional: GetConstitutionalSchema,
  admin_appeals: GetAdminAppealSchema,
  tax_tribunal: GetTaxTribunalSchema,
  tax_rulings: GetRulingTextSchema,
  interpretations: GetRulingTextSchema,
  customs: GetRulingTextSchema,
  competition: GetCompetitionSchema,
  workplace: GetWorkplaceSchema,
  privacy: GetPrivacySchema,
  integrity: GetIntegritySchema,
  public_service: GetPublicServiceSchema,
  university_rules: GetStateLawTextSchema,
  agency_rules: GetRegisteredInstrumentSchema,
  gazettes: GetRegisteredInstrumentSchema,
  treaties: GetTreatyTextSchema,
  explanatory: GetExplanatoryTextSchema,
  state_law: GetStateLawTextSchema,
}

/**
 * Declared by the handler's schema but unreachable through the dispatcher, so
 * documenting it would advertise a key that does nothing. `get_decision_text`
 * always sets `id`, and `getCaseText` returns from its `id` branch before it
 * looks at `citation` (`src/tools/precedents.ts`).
 */
const SHADOWED: Record<string, string[]> = { cases: ["citation"] }

/** The dispatcher's own parameters — the keys `options` may not carry. */
const SEARCH_RESERVED = new Set(shapeKeys(SearchDecisionsSchema).filter((key) => key !== "options"))
const GET_RESERVED = new Set(shapeKeys(GetDecisionTextSchema).filter((key) => key !== "options"))

function honoured(
  domain: string,
  schemas: Record<string, z.ZodType>,
  reserved: ReadonlySet<string>,
): string[] {
  const shadowed = SHADOWED[domain] ?? []
  return shapeKeys(schemas[domain]).filter(
    (key) => !reserved.has(key) && !shadowed.includes(key),
  )
}

const CASES: Array<{
  tool: string
  claims: Claim[]
  schemas: Record<string, z.ZodType>
  reserved: ReadonlySet<string>
}> = [
  {
    tool: "search_decisions",
    claims: parseClaims(SEARCH_SECTION),
    schemas: SEARCH_SCHEMAS as unknown as Record<string, z.ZodType>,
    reserved: SEARCH_RESERVED,
  },
  {
    tool: "get_decision_text",
    claims: parseClaims(GET_SECTION),
    schemas: GET_SCHEMAS,
    reserved: GET_RESERVED,
  },
]

for (const { tool, claims, schemas, reserved } of CASES) {
  describe(`docs/API.md — ${tool} options`, () => {
    const documented = documentedOptions(claims)

    it("covers all eighteen domains", () => {
      expect([...documented.keys()].sort()).toEqual([...DECISION_DOMAINS].sort())
    })

    it("documents no key the dispatcher drops", () => {
      // A reserved key in `options` never reaches the handler: it is dropped
      // and the response says so. Advertising one sends the caller round a
      // parameter that cannot work. Every offender is listed at once, so one
      // run names the whole repair.
      const dropped: string[] = []
      for (const [domain, keys] of documented) {
        for (const key of keys) if (reserved.has(key)) dropped.push(`${domain}:${key}`)
      }
      expect(dropped, `${tool} — documented but dropped as a reserved key`).toEqual([])
    })

    it("documents no key the domain's own schema never declares", () => {
      // The exact shape of the round-6 defect: `tax_rulings:{asAt}` on the
      // search side. Zod strips it, the handler never reads it, and the caller
      // believes a point-in-time search happened.
      const inert: string[] = []
      for (const [domain, keys] of documented) {
        const declared = new Set(shapeKeys(schemas[domain]))
        for (const key of keys) if (!declared.has(key)) inert.push(`${domain}:${key}`)
      }
      expect(inert, `${tool} — documented but never read by the handler`).toEqual([])
    })

    it("documents every key the domain does honour", () => {
      // The other half: an option the code supports and the document never
      // names is a capability the caller cannot find.
      for (const domain of DECISION_DOMAINS) {
        const keys = documented.get(domain) ?? []
        expect([...keys].sort(), `${tool}(domain="${domain}")`).toEqual(
          honoured(domain, schemas, reserved).sort(),
        )
      }
    })
  })
}

/** The description cell of one parameter row of a tool's table. */
function parameterRow(sectionText: string, parameter: string): string {
  const row = new RegExp(`^\\| \`${parameter}\` \\|.*$`, "m").exec(sectionText)
  if (!row) throw new Error(`docs/API.md has no ${parameter} row`)
  return row[0]
}

/** The domains a row names, in enum order. */
function domainsNamed(row: string): string[] {
  const named = new Set([...row.matchAll(/`([a-z_]+)`/g)].map((match) => match[1]))
  return DECISION_DOMAINS.filter((domain) => named.has(domain))
}

/** Domains whose schema does not declare `key`, so their handler cannot read it. */
function without(key: string, schemas: Record<string, z.ZodType>): string[] {
  return DECISION_DOMAINS.filter((domain) => !shapeKeys(schemas[domain]).includes(key))
}

describe("docs/API.md — the shared parameters, per domain", () => {
  // The `options` row is not the only place a documented parameter can be inert:
  // five of the eighteen search schemas have no `page` at all, and seven of the
  // get schemas have no `full`. A caller paging through `state_law` or asking
  // `explanatory` for page 2 gets page 1 back with nothing said.
  const searchSchemas = SEARCH_SCHEMAS as unknown as Record<string, z.ZodType>

  it("names every domain that does not require a query", () => {
    const optional = DECISION_DOMAINS.filter((domain) => {
      const shape = (searchSchemas[domain] as unknown as { shape: Record<string, z.ZodType | undefined> })
        .shape
      const query = shape.query
      return query === undefined || query.safeParse(undefined).success
    })
    expect(domainsNamed(parameterRow(SEARCH_SECTION, "query"))).toEqual(optional)
  })

  it("names every domain that ignores limit", () => {
    // Subset, not equality: the row also names the domains where `limit` trims
    // the fetched page instead of widening the search.
    const row = domainsNamed(parameterRow(SEARCH_SECTION, "limit"))
    for (const domain of without("limit", searchSchemas)) {
      expect(row, `search_decisions limit — ${domain} ignores it`).toContain(domain)
    }
  })

  it("gives limit the default the tool actually applies", () => {
    // `.default(10).optional()` still fills the default in, so a domain whose
    // own tool defaults to 20 is called with 10 through this one.
    expect(SearchDecisionsSchema.parse({ domain: "gazettes", query: "x" }).limit).toBe(10)
  })

  it("names every domain that ignores page", () => {
    expect(domainsNamed(parameterRow(SEARCH_SECTION, "page"))).toEqual(without("page", searchSchemas))
  })

  it("names every domain that cannot act on full", () => {
    expect(domainsNamed(parameterRow(GET_SECTION, "full"))).toEqual(without("full", GET_SCHEMAS))
  })
})

describe("docs/API.md — the decision-id table", () => {
  /** Any upstream call is a bug in this test, not a network dependency. */
  const noNetworkClient = new Proxy({} as never, {
    get() {
      return () => {
        throw new Error("network access in a unit test")
      }
    },
  })

  const table = section("### Decision ids by domain", "### Error labels")
  const rows = [...table.matchAll(/^\| `([a-z_]+)` \| (.+) \| (.+) \|$/gm)].map((row) => ({
    domain: row[1],
    examples: [...row[3].matchAll(/`([^`]+)`/g)].map((match) => match[1]),
  }))

  it("has a row for every domain", () => {
    expect(rows.map((row) => row.domain).sort()).toEqual([...DECISION_DOMAINS].sort())
  })

  for (const { domain, examples } of rows) {
    for (const example of examples) {
      it(`${domain}: ${example} is an id form get_decision_text recognises`, async () => {
        // A worked example the dispatcher rejects out of hand teaches the
        // caller an id shape that cannot work — `[2020] HCA 41` was documented
        // for `cases`, whose handler routes on the `nsw:`/`hca:`/`qld:` prefix
        // and answers a bare citation with `[INVALID_PARAMETER]`.
        const result = await getDecisionText(noNetworkClient, {
          domain: domain as (typeof DECISION_DOMAINS)[number],
          id: example,
          // Domains that need one are refused before the id is looked at.
          options: { jurisdiction: "QLD" },
        })
        const text = result.content.map((entry) => entry.text ?? "").join("\n")
        expect(text, `${domain}: ${example}`).not.toMatch(/Unrecognis/i)
      })
    }
  }
})
