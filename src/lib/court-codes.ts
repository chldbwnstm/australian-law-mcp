/**
 * Medium-neutral citation court identifiers (AGLC4 r 2.3.1 + Appendix B,
 * cross-checked against current practice in docs/research §4.4).
 *
 * `from` is the year the body started allocating MNCs. A citation earlier
 * than that is *warned about*, never rejected: databases do back-fill, and a
 * verifier that turns "this looks early" into "this does not exist" is the
 * failure mode this whole server is built to avoid.
 *
 * Historical bodies (FWA, AIRC, AATA, FamCA, NSWADT…) stay in the table
 * forever. They are still cited daily; dropping them would make every one of
 * those citations read as an unknown court.
 */

export type Jurisdiction = "Cth" | "NSW" | "Vic" | "Qld" | "SA" | "WA" | "Tas" | "ACT" | "NT"

export interface CourtCode {
  /** Canonical MNC token, exactly as it must be written (no trailing full stop). */
  code: string
  name: string
  jurisdiction: Jurisdiction
  /** First year the body allocated MNCs, where known. */
  from?: number
  /** Last year it allocated them — set only for abolished/renamed bodies. */
  until?: number
  /** True for tribunals and commissions, which do not create binding precedent. */
  tribunal?: true
  /** Body that took over its work, for a closed jurisdiction. */
  successor?: string
}

export const COURT_CODES: readonly CourtCode[] = [
  // ── Commonwealth: courts ────────────────────────────────────────────────
  { code: "HCA", name: "High Court of Australia", jurisdiction: "Cth", from: 1998 },
  { code: "HCASL", name: "High Court of Australia (special leave dispositions)", jurisdiction: "Cth", from: 2008 },
  { code: "HCASJ", name: "High Court of Australia (single justice)", jurisdiction: "Cth", from: 2024 },
  { code: "FCA", name: "Federal Court of Australia", jurisdiction: "Cth", from: 1999 },
  { code: "FCAFC", name: "Federal Court of Australia (Full Court)", jurisdiction: "Cth", from: 2002 },
  { code: "FamCA", name: "Family Court of Australia", jurisdiction: "Cth", from: 1998, until: 2021, successor: "FedCFamC1F" },
  { code: "FamCAFC", name: "Family Court of Australia (Full Court)", jurisdiction: "Cth", from: 2008, until: 2021, successor: "FedCFamC1A" },
  { code: "FCCA", name: "Federal Circuit Court of Australia", jurisdiction: "Cth", from: 2013, until: 2021, successor: "FedCFamC2G" },
  { code: "FMCA", name: "Federal Magistrates Court of Australia", jurisdiction: "Cth", until: 2013, successor: "FCCA" },
  { code: "FMCAfam", name: "Federal Magistrates Court of Australia (family law)", jurisdiction: "Cth", until: 2013, successor: "FCCA" },
  { code: "FedCFamC1F", name: "Federal Circuit and Family Court of Australia (Division 1, first instance)", jurisdiction: "Cth", from: 2021 },
  { code: "FedCFamC1A", name: "Federal Circuit and Family Court of Australia (Division 1, appellate)", jurisdiction: "Cth", from: 2021 },
  { code: "FedCFamC2F", name: "Federal Circuit and Family Court of Australia (Division 2, family law)", jurisdiction: "Cth", from: 2021 },
  { code: "FedCFamC2G", name: "Federal Circuit and Family Court of Australia (Division 2, general federal law)", jurisdiction: "Cth", from: 2021 },
  { code: "FCFCOA", name: "Federal Circuit and Family Court of Australia", jurisdiction: "Cth", from: 2021 },

  // ── Commonwealth: tribunals ─────────────────────────────────────────────
  { code: "ARTA", name: "Administrative Review Tribunal", jurisdiction: "Cth", from: 2024, tribunal: true },
  { code: "AATA", name: "Administrative Appeals Tribunal", jurisdiction: "Cth", until: 2024, tribunal: true, successor: "ARTA" },
  { code: "FWC", name: "Fair Work Commission", jurisdiction: "Cth", from: 2013, tribunal: true },
  { code: "FWCFB", name: "Fair Work Commission (Full Bench)", jurisdiction: "Cth", from: 2013, tribunal: true },
  { code: "FWA", name: "Fair Work Australia", jurisdiction: "Cth", from: 2009, until: 2013, tribunal: true, successor: "FWC" },
  { code: "FWAFB", name: "Fair Work Australia (Full Bench)", jurisdiction: "Cth", from: 2009, until: 2013, tribunal: true, successor: "FWCFB" },
  { code: "AIRC", name: "Australian Industrial Relations Commission", jurisdiction: "Cth", until: 2009, tribunal: true, successor: "FWA" },
  { code: "AIRCFB", name: "Australian Industrial Relations Commission (Full Bench)", jurisdiction: "Cth", until: 2009, tribunal: true, successor: "FWAFB" },
  { code: "ACompT", name: "Australian Competition Tribunal", jurisdiction: "Cth", tribunal: true },
  { code: "ACopyT", name: "Copyright Tribunal of Australia", jurisdiction: "Cth", tribunal: true },
  { code: "AICmr", name: "Australian Information Commissioner", jurisdiction: "Cth", from: 2010, tribunal: true },
  { code: "AICmrCN", name: "Australian Information Commissioner (case notes)", jurisdiction: "Cth", from: 2010, tribunal: true },
  { code: "ATP", name: "Takeovers Panel", jurisdiction: "Cth", tribunal: true },
  { code: "NNTTA", name: "National Native Title Tribunal", jurisdiction: "Cth", tribunal: true },
  { code: "ADFDAT", name: "Defence Force Discipline Appeal Tribunal", jurisdiction: "Cth", tribunal: true },

  // ── New South Wales ─────────────────────────────────────────────────────
  { code: "NSWSC", name: "Supreme Court of New South Wales", jurisdiction: "NSW", from: 1999 },
  { code: "NSWCA", name: "New South Wales Court of Appeal", jurisdiction: "NSW", from: 1999 },
  { code: "NSWCCA", name: "New South Wales Court of Criminal Appeal", jurisdiction: "NSW", from: 1999 },
  { code: "NSWLEC", name: "Land and Environment Court of New South Wales", jurisdiction: "NSW" },
  { code: "NSWDC", name: "District Court of New South Wales", jurisdiction: "NSW" },
  { code: "NSWLC", name: "Local Court of New South Wales", jurisdiction: "NSW" },
  { code: "NSWIRComm", name: "Industrial Relations Commission of New South Wales", jurisdiction: "NSW" },
  { code: "NSWCAT", name: "NSW Civil and Administrative Tribunal", jurisdiction: "NSW", from: 2014, tribunal: true },
  { code: "NSWCATAD", name: "NCAT Administrative and Equal Opportunity Division", jurisdiction: "NSW", from: 2014, tribunal: true },
  { code: "NSWCATAP", name: "NCAT Appeal Panel", jurisdiction: "NSW", from: 2014, tribunal: true },
  { code: "NSWCATCD", name: "NCAT Consumer and Commercial Division", jurisdiction: "NSW", from: 2014, tribunal: true },
  { code: "NSWCATGD", name: "NCAT Guardianship Division", jurisdiction: "NSW", from: 2014, tribunal: true },
  { code: "NSWCATOD", name: "NCAT Occupational Division", jurisdiction: "NSW", from: 2014, tribunal: true },
  { code: "NSWADT", name: "NSW Administrative Decisions Tribunal", jurisdiction: "NSW", until: 2014, tribunal: true, successor: "NSWCAT" },
  { code: "NSWADTAP", name: "NSW Administrative Decisions Tribunal (Appeal Panel)", jurisdiction: "NSW", until: 2014, tribunal: true, successor: "NSWCATAP" },

  // ── Victoria ────────────────────────────────────────────────────────────
  { code: "VSC", name: "Supreme Court of Victoria", jurisdiction: "Vic" },
  { code: "VSCA", name: "Victorian Court of Appeal", jurisdiction: "Vic" },
  { code: "VCC", name: "County Court of Victoria", jurisdiction: "Vic" },
  { code: "VMC", name: "Magistrates' Court of Victoria", jurisdiction: "Vic" },
  { code: "VCAT", name: "Victorian Civil and Administrative Tribunal", jurisdiction: "Vic", tribunal: true },

  // ── Queensland ──────────────────────────────────────────────────────────
  { code: "QSC", name: "Supreme Court of Queensland", jurisdiction: "Qld" },
  { code: "QCA", name: "Queensland Court of Appeal", jurisdiction: "Qld" },
  { code: "QDC", name: "District Court of Queensland", jurisdiction: "Qld" },
  { code: "QMC", name: "Magistrates Courts of Queensland", jurisdiction: "Qld" },
  { code: "QCAT", name: "Queensland Civil and Administrative Tribunal", jurisdiction: "Qld", tribunal: true },
  { code: "QCATA", name: "Queensland Civil and Administrative Tribunal (Appeals)", jurisdiction: "Qld", tribunal: true },

  // ── South Australia ─────────────────────────────────────────────────────
  { code: "SASC", name: "Supreme Court of South Australia", jurisdiction: "SA" },
  { code: "SASCFC", name: "Supreme Court of South Australia (Full Court)", jurisdiction: "SA" },
  { code: "SASCA", name: "South Australian Court of Appeal", jurisdiction: "SA" },
  { code: "SADC", name: "District Court of South Australia", jurisdiction: "SA" },
  { code: "SAERDC", name: "Environment, Resources and Development Court of South Australia", jurisdiction: "SA" },
  { code: "SACAT", name: "South Australian Civil and Administrative Tribunal", jurisdiction: "SA", tribunal: true },

  // ── Western Australia ───────────────────────────────────────────────────
  { code: "WASC", name: "Supreme Court of Western Australia", jurisdiction: "WA" },
  { code: "WASCA", name: "Supreme Court of Western Australia (Court of Appeal)", jurisdiction: "WA", from: 1999 },
  { code: "WADC", name: "District Court of Western Australia", jurisdiction: "WA" },
  { code: "WASAT", name: "State Administrative Tribunal of Western Australia", jurisdiction: "WA", tribunal: true },

  // ── Tasmania ────────────────────────────────────────────────────────────
  { code: "TASSC", name: "Supreme Court of Tasmania", jurisdiction: "Tas" },
  { code: "TASCCA", name: "Tasmanian Court of Criminal Appeal", jurisdiction: "Tas" },
  { code: "TASFC", name: "Supreme Court of Tasmania (Full Court)", jurisdiction: "Tas" },
  { code: "TASCAT", name: "Tasmanian Civil and Administrative Tribunal", jurisdiction: "Tas", tribunal: true },

  // ── Australian Capital Territory ────────────────────────────────────────
  { code: "ACTSC", name: "Supreme Court of the Australian Capital Territory", jurisdiction: "ACT" },
  { code: "ACTCA", name: "ACT Court of Appeal", jurisdiction: "ACT" },
  { code: "ACTMC", name: "ACT Magistrates Court", jurisdiction: "ACT" },
  { code: "ACAT", name: "ACT Civil and Administrative Tribunal", jurisdiction: "ACT", tribunal: true },

  // ── Northern Territory ──────────────────────────────────────────────────
  { code: "NTSC", name: "Supreme Court of the Northern Territory", jurisdiction: "NT" },
  { code: "NTCA", name: "Northern Territory Court of Appeal", jurisdiction: "NT" },
  { code: "NTCCA", name: "Northern Territory Court of Criminal Appeal", jurisdiction: "NT" },
  { code: "NTMC", name: "Local Court of the Northern Territory", jurisdiction: "NT" },
  { code: "NTCAT", name: "Northern Territory Civil and Administrative Tribunal", jurisdiction: "NT", tribunal: true },
]

/**
 * Lookup is case-insensitive because MNC tokens arrive from prose, headnotes
 * and user typing in every case ("nswca", "NSWCA", "NswCA"). The canonical
 * spelling in `code` is what gets emitted back.
 */
const byNormalised = new Map<string, CourtCode>(
  COURT_CODES.map((entry) => [entry.code.toUpperCase(), entry]),
)

/**
 * Strip the dotted/spaced forms lawyers still type — `F.C.A.F.C.`,
 * `N.S.W.C.A.` — down to the canonical token. Also drops a trailing full
 * stop, which AGLC r 2.3.1 says an MNC identifier never carries.
 */
export function normaliseCourtToken(token: string): string {
  return token.replace(/[.\s]/g, "").toUpperCase()
}

export function lookupCourt(token: string): CourtCode | undefined {
  return byNormalised.get(normaliseCourtToken(token))
}
