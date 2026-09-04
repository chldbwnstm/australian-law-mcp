/**
 * Schema → flags, and a flag's text → the value the schema wants.
 *
 * Plain Zod schemas, no registry: this module is part of the source-agnostic
 * core and must not learn which tools happen to be registered.
 */

import { describe, expect, it } from "vitest"
import { z } from "zod"
import { coerceValue, extractOptionsFromSchema } from "./cli-format.js"

describe("extractOptionsFromSchema", () => {
  const schema = z.object({
    query: z.string().describe("what to search for"),
    limit: z.number().optional().default(10),
    inForceOnly: z.boolean().optional().default(true),
    jurisdictions: z.array(z.string()).optional(),
    options: z.record(z.string(), z.unknown()).optional().describe("domain-specific filters"),
  })
  const options = new Map(extractOptionsFromSchema(schema).map((option) => [option.name, option]))

  it("reads each JSON-Schema type", () => {
    expect(options.get("query")?.type).toBe("string")
    expect(options.get("limit")?.type).toBe("number")
    expect(options.get("inForceOnly")?.type).toBe("boolean")
    expect(options.get("jurisdictions")?.type).toBe("array")
  })

  it("types a record-valued parameter as an object rather than a string", () => {
    // Left as "string", the raw text reached Zod and the flag could never be
    // satisfied: "options: Invalid input: expected record, received string".
    expect(options.get("options")?.type).toBe("object")
  })

  it("keeps the description and the default", () => {
    expect(options.get("options")?.description).toBe("domain-specific filters")
    expect(options.get("inForceOnly")?.defaultValue).toBe(true)
    expect(options.get("query")?.required).toBe(true)
    expect(options.get("limit")?.required).toBe(false)
  })
})

describe("coerceValue", () => {
  it("parses a JSON object", () => {
    expect(coerceValue('{"court":"HCA"}', "object")).toEqual({ court: "HCA" })
    expect(coerceValue("{}", "object")).toEqual({})
  })

  it("says what an object parameter wanted when the text is not JSON", () => {
    // The alternative is returning the raw string, which puts back the
    // "expected record, received string" message that says nothing about what
    // was wrong with what was typed.
    expect(() => coerceValue("court=HCA", "object")).toThrow(/JSON object/)
    expect(() => coerceValue("[1,2]", "object")).toThrow(/an array/)
    expect(() => coerceValue("null", "object")).toThrow(/JSON object/)
  })

  it("leaves the other types as they were", () => {
    expect(coerceValue("5", "number")).toBe(5)
    expect(coerceValue("true", "boolean")).toBe(true)
    expect(coerceValue("false", "boolean")).toBe(false)
    expect(coerceValue("a,b", "array")).toEqual(["a", "b"])
    expect(coerceValue('["a","b"]', "array")).toEqual(["a", "b"])
    expect(coerceValue("s 18", "string")).toBe("s 18")
  })
})
