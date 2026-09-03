/**
 * Curated Commonwealth ⇄ State/Territory statute families.
 *
 * There is no machine-readable index of "the NSW equivalent of this Act": the
 * Federal Register holds Commonwealth law only, and the eight state registers
 * share no identifier scheme. Guessing by name is how a tool ends up telling a
 * user that the *Crimes Act 1900* (NSW) is "the NSW version of" the *Criminal
 * Code Act 1995* (Cth) — related, but not the same instrument in the way that
 * phrasing implies.
 *
 * So this is hand-written data, deliberately small, covering only the famous
 * harmonised/applied families where the relationship is a documented legislative
 * scheme. Every row records **how** the jurisdictions relate, because "uniform",
 * "applied" and "merely comparable" carry different legal weight:
 *
 *  - `applied`   — the state Act applies a Commonwealth text as state law
 *                  (ACL: each state's Fair Trading Act applies the CCA sch 2).
 *  - `uniform`   — separately enacted from an agreed model, near-identical text.
 *  - `comparable`— same subject matter, independently drafted. Section numbers
 *                  do NOT correspond, and the tool says so.
 *
 * Notable non-adopters are rows in their own right (`variant: "not-adopted"`).
 * Leaving Victoria out of the WHS family would read as an oversight; saying
 * Victoria kept the OHS Act 2004 is the actual answer.
 */

import type { AliasJurisdiction } from "../../lib/law-alias.js"

export type FamilyRelation = "applied" | "uniform" | "comparable"

export interface StateCounterpart {
  jurisdiction: AliasJurisdiction
  title: string
  /** Where the family's substance actually sits, when it is not the whole Act. */
  pinpoint?: string
  variant?: "not-adopted" | "modified"
  note?: string
}

export interface StatuteFamily {
  key: string
  label: string
  relation: FamilyRelation
  /** The Commonwealth anchor, when there is one. */
  commonwealth?: { title: string; titleId?: string; pinpoint?: string }
  members: StateCounterpart[]
  /** What a reader must not conclude from the table. */
  caution: string
  /** Alias/name fragments that select this family. */
  match: string[]
}

export const STATUTE_FAMILIES: readonly StatuteFamily[] = [
  {
    key: "acl",
    label: "Australian Consumer Law",
    relation: "applied",
    commonwealth: {
      title: "Competition and Consumer Act 2010",
      titleId: "C2004A00109",
      pinpoint: "sch 2 (the ACL); applied federally by pt XI",
    },
    members: [
      { jurisdiction: "NSW", title: "Fair Trading Act 1987 (NSW)", pinpoint: "pt 3" },
      { jurisdiction: "Vic", title: "Australian Consumer Law and Fair Trading Act 2012 (Vic)", pinpoint: "pt 1.2" },
      { jurisdiction: "Qld", title: "Fair Trading Act 1989 (Qld)", pinpoint: "pt 3" },
      { jurisdiction: "SA", title: "Fair Trading Act 1987 (SA)", pinpoint: "pt 3" },
      { jurisdiction: "WA", title: "Fair Trading Act 2010 (WA)", pinpoint: "pt 3" },
      { jurisdiction: "Tas", title: "Australian Consumer Law (Tasmania) Act 2010 (Tas)" },
      { jurisdiction: "ACT", title: "Fair Trading (Australian Consumer Law) Act 1992 (ACT)" },
      { jurisdiction: "NT", title: "Consumer Affairs and Fair Trading Act 1990 (NT)", pinpoint: "pt 4" },
    ],
    caution:
      "These Acts APPLY the same text (CCA sch 2) as a law of their own jurisdiction — so 'ACL s 18' means the identical provision everywhere. " +
      "What differs is which regulator enforces it and which court hears it, not the wording.",
    match: ["australian consumer law", "acl", "competition and consumer act", "fair trading"],
  },
  {
    key: "whs",
    label: "Work Health and Safety (model WHS laws)",
    relation: "uniform",
    commonwealth: { title: "Work Health and Safety Act 2011", titleId: "C2011A00137" },
    members: [
      { jurisdiction: "NSW", title: "Work Health and Safety Act 2011 (NSW)" },
      { jurisdiction: "Qld", title: "Work Health and Safety Act 2011 (Qld)" },
      { jurisdiction: "SA", title: "Work Health and Safety Act 2012 (SA)" },
      { jurisdiction: "Tas", title: "Work Health and Safety Act 2012 (Tas)" },
      { jurisdiction: "ACT", title: "Work Health and Safety Act 2011 (ACT)" },
      { jurisdiction: "NT", title: "Work Health and Safety (National Uniform Legislation) Act 2011 (NT)" },
      {
        jurisdiction: "WA",
        title: "Work Health and Safety Act 2020 (WA)",
        variant: "modified",
        note: "Adopted the model law late and with departures (commenced 31 March 2022).",
      },
      {
        jurisdiction: "Vic",
        title: "Occupational Health and Safety Act 2004 (Vic)",
        variant: "not-adopted",
        note: "Victoria did NOT adopt the model WHS laws. Section numbers and duty formulations differ — do not map WHS s 19 onto an OHS Act section.",
      },
    ],
    caution:
      "Uniform, not applied: each jurisdiction enacted its own Act from the model. Numbering matches closely in the adopting jurisdictions, " +
      "but local amendments accumulate — verify the section text in the jurisdiction you are advising on.",
    match: ["work health and safety", "whs", "occupational health and safety", "ohs"],
  },
  {
    key: "uea",
    label: "Uniform Evidence Acts",
    relation: "uniform",
    commonwealth: { title: "Evidence Act 1995", titleId: "C2004A04858" },
    members: [
      { jurisdiction: "NSW", title: "Evidence Act 1995 (NSW)" },
      { jurisdiction: "Vic", title: "Evidence Act 2008 (Vic)" },
      { jurisdiction: "Tas", title: "Evidence Act 2001 (Tas)" },
      { jurisdiction: "ACT", title: "Evidence Act 2011 (ACT)" },
      { jurisdiction: "NT", title: "Evidence (National Uniform Legislation) Act 2011 (NT)" },
      {
        jurisdiction: "Qld",
        title: "Evidence Act 1977 (Qld)",
        variant: "not-adopted",
        note: "Queensland is a non-UEA jurisdiction — common law plus its own Act. Section numbers do not correspond.",
      },
      {
        jurisdiction: "SA",
        title: "Evidence Act 1929 (SA)",
        variant: "not-adopted",
        note: "South Australia is a non-UEA jurisdiction. Section numbers do not correspond.",
      },
      {
        jurisdiction: "WA",
        title: "Evidence Act 1906 (WA)",
        variant: "not-adopted",
        note: "Western Australia is a non-UEA jurisdiction. Section numbers do not correspond.",
      },
    ],
    caution:
      "Within the uniform-evidence jurisdictions the numbering aligns (s 138 is the improperly-obtained-evidence discretion in each). " +
      "In Qld, SA and WA it does NOT — citing 'Evidence Act s 138' there is a citation error, not a local variation.",
    match: ["evidence act", "uniform evidence", "uea"],
  },
  {
    key: "criminal",
    label: "Principal criminal statutes",
    relation: "comparable",
    commonwealth: { title: "Criminal Code Act 1995", titleId: "C2004A04868", pinpoint: "sch 1 (the Criminal Code)" },
    members: [
      { jurisdiction: "NSW", title: "Crimes Act 1900 (NSW)", note: "Common law jurisdiction." },
      { jurisdiction: "Vic", title: "Crimes Act 1958 (Vic)", note: "Common law jurisdiction." },
      { jurisdiction: "Qld", title: "Criminal Code Act 1899 (Qld)", pinpoint: "sch 1 (the Criminal Code)", note: "Code jurisdiction." },
      { jurisdiction: "SA", title: "Criminal Law Consolidation Act 1935 (SA)", note: "Common law jurisdiction." },
      { jurisdiction: "WA", title: "Criminal Code Act Compilation Act 1913 (WA)", pinpoint: "app B sch (the Criminal Code)", note: "Code jurisdiction." },
      { jurisdiction: "Tas", title: "Criminal Code Act 1924 (Tas)", pinpoint: "sch 1 (the Criminal Code)", note: "Code jurisdiction." },
      { jurisdiction: "ACT", title: "Criminal Code 2002 (ACT)", note: "Older offences remain in the Crimes Act 1900 (ACT)." },
      { jurisdiction: "NT", title: "Criminal Code Act 1983 (NT)", pinpoint: "sch 1 (the Criminal Code)", note: "Code jurisdiction." },
    ],
    caution:
      "Comparable subject matter only — these are independently drafted, and code vs common-law jurisdictions differ in substance, not just numbering. " +
      "Never translate a section number across this family.",
    match: ["crimes act", "criminal code", "criminal law consolidation"],
  },
  {
    key: "defamation",
    label: "Uniform Defamation Acts",
    relation: "uniform",
    members: [
      { jurisdiction: "NSW", title: "Defamation Act 2005 (NSW)" },
      { jurisdiction: "Vic", title: "Defamation Act 2005 (Vic)" },
      { jurisdiction: "Qld", title: "Defamation Act 2005 (Qld)" },
      { jurisdiction: "SA", title: "Defamation Act 2005 (SA)" },
      { jurisdiction: "WA", title: "Defamation Act 2005 (WA)" },
      { jurisdiction: "Tas", title: "Defamation Act 2005 (Tas)" },
      { jurisdiction: "NT", title: "Defamation Act 2006 (NT)" },
      { jurisdiction: "ACT", title: "Civil Law (Wrongs) Act 2002 (ACT)", pinpoint: "ch 9", variant: "modified" },
    ],
    caution:
      "There is no Commonwealth defamation Act. The 2005 scheme is uniform, but the 2021 and 2024 model amendments were adopted on " +
      "different dates in different jurisdictions — check commencement before relying on the serious-harm threshold or the public-interest defence.",
    match: ["defamation", "civil law (wrongs)"],
  },
]

/** Human URL for a jurisdiction's own register — the state text is not fetched by this server. */
export const REGISTER_URLS: Readonly<Record<AliasJurisdiction, string>> = {
  Cth: "https://www.legislation.gov.au",
  NSW: "https://legislation.nsw.gov.au",
  Vic: "https://www.legislation.vic.gov.au",
  Qld: "https://www.legislation.qld.gov.au",
  SA: "https://www.legislation.sa.gov.au",
  WA: "https://www.legislation.wa.gov.au",
  Tas: "https://www.legislation.tas.gov.au",
  ACT: "https://www.legislation.act.gov.au",
  NT: "https://legislation.nt.gov.au",
}

function fold(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "")
}

/** Families whose `match` fragments overlap the query, best first. */
export function findFamilies(query: string): StatuteFamily[] {
  const key = fold(query)
  if (!key) return []
  return STATUTE_FAMILIES.map((family) => {
    let best = 0
    for (const fragment of family.match) {
      const folded = fold(fragment)
      if (!folded) continue
      if (key === folded) best = Math.max(best, 3)
      else if (key.includes(folded) || folded.includes(key)) best = Math.max(best, folded.length >= 4 ? 2 : 1)
    }
    return { family, best }
  })
    .filter((entry) => entry.best > 0)
    .sort((a, b) => b.best - a.best)
    .map((entry) => entry.family)
}
