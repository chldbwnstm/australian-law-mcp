/**
 * CLI output formatting utilities.
 * Colour, banner, tool listing, schema extraction.
 */

import { z } from "zod"
import type { McpTool } from "./types.js"
import { VERSION } from "../version.js"

// ────────────────────────────────────────
// ANSI Color Formatting
// ────────────────────────────────────────

export const isColorSupported = process.stdout.isTTY && !process.env.NO_COLOR

/**
 * ANSI formatting helpers.
 * Avoids the nesting problem where an inner \x1b[0m resets the outer style:
 * use a single wrapper, or a dedicated function for a compound style.
 */
export const fmt = {
  bold: (s: string) => isColorSupported ? `\x1b[1m${s}\x1b[22m` : s,
  dim: (s: string) => isColorSupported ? `\x1b[2m${s}\x1b[22m` : s,
  green: (s: string) => isColorSupported ? `\x1b[32m${s}\x1b[39m` : s,
  yellow: (s: string) => isColorSupported ? `\x1b[33m${s}\x1b[39m` : s,
  cyan: (s: string) => isColorSupported ? `\x1b[36m${s}\x1b[39m` : s,
  red: (s: string) => isColorSupported ? `\x1b[31m${s}\x1b[39m` : s,
  blue: (s: string) => isColorSupported ? `\x1b[34m${s}\x1b[39m` : s,
  magenta: (s: string) => isColorSupported ? `\x1b[35m${s}\x1b[39m` : s,
  // Compound styles (nesting-safe)
  boldCyan: (s: string) => isColorSupported ? `\x1b[1;36m${s}\x1b[0m` : s,
  boldGreen: (s: string) => isColorSupported ? `\x1b[1;32m${s}\x1b[0m` : s,
}

// ────────────────────────────────────────
// Output Formatting
// ────────────────────────────────────────

export function printBanner(toolCount?: number) {
  console.log()
  console.log(fmt.bold("  Australian Law CLI v" + VERSION))
  console.log(fmt.dim(
    toolCount === undefined
      ? "  Public Australian legal sources · natural-language input"
      : `  Public Australian legal sources · ${toolCount} tools · natural-language input`
  ))
  console.log()
}

export function printRouteInfo(tool: string, reason: string) {
  console.log(fmt.dim(`  [routing] ${tool} — ${reason}`))
  console.log()
}

export function formatOutput(text: string): string {
  if (!isColorSupported) return text

  return text
    // Section headers
    .replace(/^(═+.*═+)$/gm, (m) => fmt.boldCyan(m))
    .replace(/^(▶\s*.+)$/gm, (m) => fmt.boldGreen(m))
    // Titles
    .replace(/^(Title:\s*.+)$/gm, (m) => fmt.bold(m))
    // Hints
    .replace(/(💡.+)/g, (m) => fmt.yellow(m))
    // Errors
    .replace(/(❌.+)/g, (m) => fmt.red(m))
    // Numbered lists
    .replace(/^(\d+\.\s)/gm, (m) => fmt.cyan(m))
}

// ────────────────────────────────────────
// Interactive Help & Tool List
// ────────────────────────────────────────

export function printInteractiveHelp() {
  console.log()
  console.log(fmt.bold("  Usage:"))
  console.log(`    ${fmt.cyan("natural language")}   Search Australian law in plain English (auto-routed)`)
  console.log(`    ${fmt.cyan("@tool_name {...}")}   Call a specific tool directly`)
  console.log(`    ${fmt.cyan("explain <query>")}    Show the routing decision (does not execute)`)
  console.log(`    ${fmt.cyan("tools / list")}       List the available tools`)
  console.log(`    ${fmt.cyan("history")}            Search history`)
  console.log(`    ${fmt.cyan("exit / q")}           Quit`)
  console.log()
  console.log(fmt.bold("  Natural-language examples:"))
  console.log(fmt.dim("    Corporations Act 2001 section 180      → direct section lookup"))
  console.log(fmt.dim("    drink driving penalties NSW            → combined research"))
  console.log(fmt.dim("    unfair dismissal case law              → case-law search"))
  console.log(fmt.dim("    Fair Work Act amendment history        → amendment tracking"))
  console.log(fmt.dim("    Victorian parking local laws           → local instrument search"))
  console.log(fmt.dim("    passport application fees              → procedure and cost guidance"))
  console.log()
}

export function getCategory(tool: McpTool): string {
  const match = tool.description.match(/^\[(.+?)\]/)
  return match ? match[1] : "Other"
}

/**
 * Print the tool list grouped by category.
 *
 * The registry is passed in rather than imported: this module is part of the
 * source-agnostic core and must not depend on which tools happen to be
 * registered.
 */
export function printToolList(tools: readonly McpTool[]) {
  const grouped = new Map<string, McpTool[]>()
  for (const tool of tools) {
    const cat = getCategory(tool)
    if (!grouped.has(cat)) grouped.set(cat, [])
    grouped.get(cat)!.push(tool)
  }

  console.log(`\n${fmt.bold(`  ${tools.length} tools`)}\n`)
  for (const [cat, catTools] of grouped) {
    console.log(fmt.bold(`  ── ${cat} ──`))
    for (const t of catTools) {
      const desc = t.description.replace(/^\[.+?\]\s*/, "")
      console.log(`    ${fmt.cyan(t.name.padEnd(35))} ${fmt.dim(desc)}`)
    }
    console.log()
  }
}

// ────────────────────────────────────────
// Schema Extraction (for subcommands)
// ────────────────────────────────────────

export interface CliOption {
  name: string
  description: string
  required: boolean
  type: string
  defaultValue?: unknown
}

export function extractOptionsFromSchema(schema: z.ZodSchema): CliOption[] {
  let jsonSchema: Record<string, unknown>
  try {
    jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>
  } catch {
    return []
  }

  const schemaObj = jsonSchema as { type?: string; properties?: Record<string, Record<string, unknown>>; required?: string[] }
  if (schemaObj?.type !== "object" || !schemaObj.properties) {
    return []
  }

  const requiredFields = new Set<string>(schemaObj.required || [])
  const options: CliOption[] = []

  for (const [key, prop] of Object.entries(schemaObj.properties)) {
    let type = "string"
    const propType = prop.type

    if (propType === "number" || propType === "integer") {
      type = "number"
    } else if (propType === "boolean") {
      type = "boolean"
    } else if (propType === "array") {
      type = "array"
    }

    const hasDefault = prop.default !== undefined
    options.push({
      name: key,
      description: (prop.description as string) || "",
      required: hasDefault ? false : requiredFields.has(key),
      type,
      defaultValue: prop.default
    })
  }

  return options
}

export function coerceValue(value: string, type: string): unknown {
  switch (type) {
    case "number": return Number(value)
    case "boolean": return value === "true" || value === "1"
    case "array": {
      try { return JSON.parse(value) }
      catch { return value.split(",") }
    }
    default: return value
  }
}
