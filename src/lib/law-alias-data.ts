/**
 * Statute alias dictionary — what lawyers type mapped to official short
 * titles (docs/research §5).
 *
 * The Federal Register has **no abbreviation field**: "CCA", "ACL" and "FW
 * Act" match nothing upstream, so without this table those queries return
 * zero hits and a naive caller reports the Act does not exist. That is the
 * failure this table exists to prevent, which is why alias misses are handled
 * as "no overlap", never as absence.
 *
 * Every `titleId` below was resolved live against
 * `Titles?$filter=name eq '…' and collection eq 'Act'` on 2026-09-03; only
 * principal titles were taken. An entry with no id is deliberate — it means
 * the id has not been verified, not that none exists.
 *
 * One row per alias. The same official title appearing several times is the
 * point: `TPA` and `CCA` are the same `titleId`, and `ACL` is that title's
 * schedule 2.
 */

export type AliasJurisdiction = "Cth" | "NSW" | "Vic" | "Qld" | "SA" | "WA" | "Tas" | "ACT" | "NT"

export interface LawAliasEntry {
  /** The spoken/typed form. Matching is case- and punctuation-insensitive. */
  alias: string
  /** Official short title including its year. */
  official: string
  jurisdiction: AliasJurisdiction
  /** Federal Register title id, where live-verified. */
  titleId?: string
  /** Schedule within `official` that the alias actually names, e.g. ACL = sch 2. */
  sch?: string
  /** True when the alias is a body/agency rather than a statute. */
  body?: true
  notes?: string
}

export const LAW_ALIAS_ENTRIES: readonly LawAliasEntry[] = [
  // ── Competition and consumer ───────────────────────────────────────────
  { alias: "CCA", official: "Competition and Consumer Act 2010", jurisdiction: "Cth", titleId: "C2004A00109" },
  { alias: "Competition and Consumer Act", official: "Competition and Consumer Act 2010", jurisdiction: "Cth", titleId: "C2004A00109" },
  { alias: "TPA", official: "Competition and Consumer Act 2010", jurisdiction: "Cth", titleId: "C2004A00109", notes: "Renamed from the Trade Practices Act 1974 on 1 January 2011. Same title id — this is a rename, not a repeal." },
  { alias: "Trade Practices Act", official: "Competition and Consumer Act 2010", jurisdiction: "Cth", titleId: "C2004A00109", notes: "Former name of the CCA. Legislative instruments made under it may still carry 'Trade Practices Act 1974' in their own current names." },
  { alias: "Trade Practices Act 1974", official: "Competition and Consumer Act 2010", jurisdiction: "Cth", titleId: "C2004A00109" },
  { alias: "ACL", official: "Competition and Consumer Act 2010", jurisdiction: "Cth", titleId: "C2004A00109", sch: "2", notes: "The Australian Consumer Law is schedule 2 of the CCA, not a separate Act. ACL s 18 (misleading or deceptive conduct) is NOT CCA s 18 (meetings of Commission)." },
  { alias: "Australian Consumer Law", official: "Competition and Consumer Act 2010", jurisdiction: "Cth", titleId: "C2004A00109", sch: "2" },

  // ── Workplace ──────────────────────────────────────────────────────────
  { alias: "FW Act", official: "Fair Work Act 2009", jurisdiction: "Cth", titleId: "C2009A00028" },
  { alias: "Fair Work Act", official: "Fair Work Act 2009", jurisdiction: "Cth", titleId: "C2009A00028" },
  { alias: "FWA", official: "Fair Work Act 2009", jurisdiction: "Cth", titleId: "C2009A00028", notes: "Ambiguous: FWA is also the medium-neutral citation code for Fair Work Australia (the tribunal, 2009-2013)." },
  { alias: "FWRO Act", official: "Fair Work (Registered Organisations) Act 2009", jurisdiction: "Cth", titleId: "C2004A03679" },
  { alias: "Registered Organisations Act", official: "Fair Work (Registered Organisations) Act 2009", jurisdiction: "Cth", titleId: "C2004A03679" },
  { alias: "Fair Work Regulations", official: "Fair Work Regulations 2009", jurisdiction: "Cth" },
  { alias: "WHS Act", official: "Work Health and Safety Act 2011", jurisdiction: "Cth", titleId: "C2011A00137", notes: "Harmonised: NSW/Qld/SA/Tas/ACT/NT have their own Work Health and Safety Acts. Victoria did not adopt the model law and retains the Occupational Health and Safety Act 2004 (Vic)." },

  // ── Corporate and financial ────────────────────────────────────────────
  { alias: "Corps Act", official: "Corporations Act 2001", jurisdiction: "Cth", titleId: "C2004A00818" },
  { alias: "Corporations Act", official: "Corporations Act 2001", jurisdiction: "Cth", titleId: "C2004A00818" },
  { alias: "CA 2001", official: "Corporations Act 2001", jurisdiction: "Cth", titleId: "C2004A00818" },
  { alias: "Corporations Regulations", official: "Corporations Regulations 2001", jurisdiction: "Cth" },
  { alias: "ASIC Act", official: "Australian Securities and Investments Commission Act 2001", jurisdiction: "Cth", titleId: "C2004A00819" },
  { alias: "PPSA", official: "Personal Property Securities Act 2009", jurisdiction: "Cth", titleId: "C2009A00130", notes: "Commonwealth, not a state Act." },
  { alias: "NCCP Act", official: "National Consumer Credit Protection Act 2009", jurisdiction: "Cth", titleId: "C2009A00134" },
  { alias: "National Credit Code", official: "National Consumer Credit Protection Act 2009", jurisdiction: "Cth", titleId: "C2009A00134", sch: "1" },
  { alias: "Banking Act", official: "Banking Act 1959", jurisdiction: "Cth", titleId: "C1959A00006" },
  { alias: "ICA", official: "Insurance Contracts Act 1984", jurisdiction: "Cth", titleId: "C2004A02944" },
  { alias: "Insurance Contracts Act", official: "Insurance Contracts Act 1984", jurisdiction: "Cth", titleId: "C2004A02944" },
  { alias: "Life Insurance Act", official: "Life Insurance Act 1995", jurisdiction: "Cth", titleId: "C2004A04860" },
  { alias: "AML/CTF Act", official: "Anti-Money Laundering and Counter-Terrorism Financing Act 2006", jurisdiction: "Cth", titleId: "C2006A00169" },
  { alias: "SIS Act", official: "Superannuation Industry (Supervision) Act 1993", jurisdiction: "Cth", titleId: "C2004A04633" },

  // ── Tax ────────────────────────────────────────────────────────────────
  { alias: "ITAA 1936", official: "Income Tax Assessment Act 1936", jurisdiction: "Cth", titleId: "C1936A00027" },
  { alias: "ITAA36", official: "Income Tax Assessment Act 1936", jurisdiction: "Cth", titleId: "C1936A00027" },
  { alias: "36 Act", official: "Income Tax Assessment Act 1936", jurisdiction: "Cth", titleId: "C1936A00027" },
  { alias: "ITAA 1997", official: "Income Tax Assessment Act 1997", jurisdiction: "Cth", titleId: "C2004A05138" },
  { alias: "ITAA97", official: "Income Tax Assessment Act 1997", jurisdiction: "Cth", titleId: "C2004A05138" },
  { alias: "97 Act", official: "Income Tax Assessment Act 1997", jurisdiction: "Cth", titleId: "C2004A05138" },
  { alias: "TAA", official: "Taxation Administration Act 1953", jurisdiction: "Cth", titleId: "C1953A00001" },
  { alias: "TAA 1953", official: "Taxation Administration Act 1953", jurisdiction: "Cth", titleId: "C1953A00001" },
  { alias: "GST Act", official: "A New Tax System (Goods and Services Tax) Act 1999", jurisdiction: "Cth", titleId: "C2004A00446" },
  { alias: "FBTAA", official: "Fringe Benefits Tax Assessment Act 1986", jurisdiction: "Cth", titleId: "C2004A03280" },
  { alias: "CGT", official: "Income Tax Assessment Act 1997", jurisdiction: "Cth", titleId: "C2004A05138", notes: "Capital gains tax is not an Act — it is pts 3-1 and 3-3 of the ITAA 1997." },

  // ── Public law, interpretation, administration ─────────────────────────
  { alias: "AIA", official: "Acts Interpretation Act 1901", jurisdiction: "Cth", titleId: "C1901A00002" },
  { alias: "Acts Interpretation Act", official: "Acts Interpretation Act 1901", jurisdiction: "Cth", titleId: "C1901A00002" },
  { alias: "LA 2003", official: "Legislation Act 2003", jurisdiction: "Cth", titleId: "C2004A01224" },
  { alias: "Legislation Act", official: "Legislation Act 2003", jurisdiction: "Cth", titleId: "C2004A01224", notes: "Ambiguous with the Legislation Act 2001 (ACT)." },
  { alias: "Judiciary Act", official: "Judiciary Act 1903", jurisdiction: "Cth", titleId: "C1903A00006" },
  { alias: "ADJR Act", official: "Administrative Decisions (Judicial Review) Act 1977", jurisdiction: "Cth", titleId: "C2004A01697" },
  { alias: "ART Act", official: "Administrative Review Tribunal Act 2024", jurisdiction: "Cth", titleId: "C2024A00040" },
  { alias: "AAT Act", official: "Administrative Appeals Tribunal Act 1975", jurisdiction: "Cth", titleId: "C2004A01401", notes: "Repealed 14 October 2024. Successor regime: Administrative Review Tribunal Act 2024 (Cth)." },
  { alias: "PGPA Act", official: "Public Governance, Performance and Accountability Act 2013", jurisdiction: "Cth", titleId: "C2013A00123" },
  { alias: "PID Act", official: "Public Interest Disclosure Act 2013", jurisdiction: "Cth", titleId: "C2013A00133" },
  { alias: "Whistleblower Act", official: "Public Interest Disclosure Act 2013", jurisdiction: "Cth", titleId: "C2013A00133", notes: "Informal. Corporate whistleblowing sits in pt 9.4AAA of the Corporations Act 2001 (Cth)." },
  { alias: "NACC Act", official: "National Anti-Corruption Commission Act 2022", jurisdiction: "Cth", titleId: "C2022A00088" },
  { alias: "Constitution", official: "Commonwealth of Australia Constitution Act", jurisdiction: "Cth", titleId: "C2004Q00685", notes: "AGLC r 3.6 cites it as 'Australian Constitution s 51(xx)' with no jurisdiction bracket." },
  { alias: "Australian Constitution", official: "Commonwealth of Australia Constitution Act", jurisdiction: "Cth", titleId: "C2004Q00685" },

  // ── Privacy, information, security ─────────────────────────────────────
  { alias: "Privacy Act", official: "Privacy Act 1988", jurisdiction: "Cth", titleId: "C2004A03712" },
  { alias: "FOI Act", official: "Freedom of Information Act 1982", jurisdiction: "Cth", titleId: "C2004A02562" },
  { alias: "Archives Act", official: "Archives Act 1983", jurisdiction: "Cth", titleId: "C2004A02796" },
  { alias: "TIA Act", official: "Telecommunications (Interception and Access) Act 1979", jurisdiction: "Cth", titleId: "C2004A02124" },
  { alias: "TIAA", official: "Telecommunications (Interception and Access) Act 1979", jurisdiction: "Cth", titleId: "C2004A02124" },
  { alias: "SD Act", official: "Surveillance Devices Act 2004", jurisdiction: "Cth", titleId: "C2004A01387" },
  { alias: "NSI Act", official: "National Security Information (Criminal and Civil Proceedings) Act 2004", jurisdiction: "Cth", titleId: "C2004A01385" },

  // ── Criminal, migration, environment, native title ─────────────────────
  { alias: "Crimes Act (Cth)", official: "Crimes Act 1914", jurisdiction: "Cth", titleId: "C1914A00012" },
  { alias: "Criminal Code (Cth)", official: "Criminal Code Act 1995", jurisdiction: "Cth", titleId: "C2004A04868", notes: "The Criminal Code is the Schedule to the Act. FRL labels it 'Schedule—The Criminal Code' with no number, so a 'sch 1' pinpoint will not match the table of contents." },
  { alias: "Criminal Code", official: "Criminal Code Act 1995", jurisdiction: "Cth", titleId: "C2004A04868", notes: "Ambiguous: Queensland, Western Australia, Tasmania and the Northern Territory each have their own Criminal Code." },
  { alias: "Migration Act", official: "Migration Act 1958", jurisdiction: "Cth", titleId: "C1958A00062" },
  { alias: "MA", official: "Migration Act 1958", jurisdiction: "Cth", titleId: "C1958A00062" },
  { alias: "Citizenship Act", official: "Australian Citizenship Act 2007", jurisdiction: "Cth", titleId: "C2007A00020" },
  { alias: "Customs Act", official: "Customs Act 1901", jurisdiction: "Cth", titleId: "C1901A00006" },
  { alias: "EPBC Act", official: "Environment Protection and Biodiversity Conservation Act 1999", jurisdiction: "Cth", titleId: "C2004A00485" },
  { alias: "NTA", official: "Native Title Act 1993", jurisdiction: "Cth", titleId: "C2004A04665" },
  { alias: "Native Title Act", official: "Native Title Act 1993", jurisdiction: "Cth", titleId: "C2004A04665" },
  { alias: "Modern Slavery Act", official: "Modern Slavery Act 2018", jurisdiction: "Cth", titleId: "C2018A00153", notes: "Ambiguous with the Modern Slavery Act 2018 (NSW)." },
  { alias: "APRA Act", official: "Australian Prudential Regulation Authority Act 1998", jurisdiction: "Cth", titleId: "C2004A00310" },

  // ── Uniform Evidence Acts (§5.2) ───────────────────────────────────────
  // Queensland, Western Australia and South Australia are NOT uniform
  // evidence jurisdictions, so "Evidence Act s 138" without a jurisdiction is
  // ambiguous in a way that changes the answer, not just the citation.
  { alias: "Evidence Act (Cth)", official: "Evidence Act 1995", jurisdiction: "Cth", titleId: "C2004A04858", notes: "Uniform Evidence Act." },
  { alias: "UEA", official: "Evidence Act 1995", jurisdiction: "Cth", titleId: "C2004A04858", notes: "Uniform evidence law: Cth, NSW, Vic, Tas, ACT, NT. Qld, WA and SA are not UEA jurisdictions." },
  { alias: "Uniform Evidence Act", official: "Evidence Act 1995", jurisdiction: "Cth", titleId: "C2004A04858" },
  { alias: "Evidence Act", official: "Evidence Act 1995", jurisdiction: "Cth", titleId: "C2004A04858" },
  { alias: "Evidence Act", official: "Evidence Act 1995", jurisdiction: "NSW" },
  { alias: "Evidence Act", official: "Evidence Act 2008", jurisdiction: "Vic" },
  { alias: "Evidence Act", official: "Evidence Act 2001", jurisdiction: "Tas" },
  { alias: "Evidence Act", official: "Evidence Act 2011", jurisdiction: "ACT" },
  { alias: "Evidence Act", official: "Evidence (National Uniform Legislation) Act 2011", jurisdiction: "NT" },
  { alias: "Evidence Act", official: "Evidence Act 1977", jurisdiction: "Qld", notes: "Not a uniform evidence jurisdiction." },
  { alias: "Evidence Act", official: "Evidence Act 1906", jurisdiction: "WA", notes: "Not a uniform evidence jurisdiction." },
  { alias: "Evidence Act", official: "Evidence Act 1929", jurisdiction: "SA", notes: "Not a uniform evidence jurisdiction." },

  // ── State and territory (§5.3) ─────────────────────────────────────────
  { alias: "Crimes Act", official: "Crimes Act 1900", jurisdiction: "NSW" },
  { alias: "Crimes Act", official: "Crimes Act 1958", jurisdiction: "Vic" },
  { alias: "Crimes Act", official: "Crimes Act 1914", jurisdiction: "Cth", titleId: "C1914A00012" },
  { alias: "Crimes Act", official: "Crimes Act 1900", jurisdiction: "ACT" },
  { alias: "Criminal Code", official: "Criminal Code Act 1899", jurisdiction: "Qld" },
  { alias: "Criminal Code", official: "Criminal Code Act Compilation Act 1913", jurisdiction: "WA" },
  { alias: "Criminal Code", official: "Criminal Code Act 1924", jurisdiction: "Tas" },
  { alias: "Criminal Code", official: "Criminal Code Act 1983", jurisdiction: "NT" },

  { alias: "CLA", official: "Civil Liability Act 2002", jurisdiction: "NSW", notes: "Vic, Qld, WA, Tas and the ACT have comparable Acts with different section numbering." },
  { alias: "Civil Liability Act", official: "Civil Liability Act 2002", jurisdiction: "NSW" },
  { alias: "Civil Liability Act", official: "Civil Liability Act 2003", jurisdiction: "Qld" },
  { alias: "Civil Liability Act", official: "Civil Liability Act 2002", jurisdiction: "Tas" },
  { alias: "Civil Liability Act", official: "Civil Liability Act 2002", jurisdiction: "WA" },
  { alias: "Civil Liability Act", official: "Civil Law (Wrongs) Act 2002", jurisdiction: "ACT" },
  { alias: "Civil Liability Act", official: "Wrongs Act 1958", jurisdiction: "Vic", notes: "Victoria's equivalent is the Wrongs Act, not a Civil Liability Act." },

  { alias: "CPA", official: "Civil Procedure Act 2005", jurisdiction: "NSW" },
  { alias: "UCPR", official: "Uniform Civil Procedure Rules 2005", jurisdiction: "NSW" },
  { alias: "EPA", official: "Environmental Planning and Assessment Act 1979", jurisdiction: "NSW" },
  { alias: "EP&A Act", official: "Environmental Planning and Assessment Act 1979", jurisdiction: "NSW" },
  { alias: "POEO Act", official: "Protection of the Environment Operations Act 1997", jurisdiction: "NSW" },
  { alias: "LEPRA", official: "Law Enforcement (Powers and Responsibilities) Act 2002", jurisdiction: "NSW" },
  { alias: "Sentencing Act", official: "Crimes (Sentencing Procedure) Act 1999", jurisdiction: "NSW" },
  { alias: "Sentencing Act", official: "Sentencing Act 1991", jurisdiction: "Vic" },
  { alias: "Bail Act", official: "Bail Act 2013", jurisdiction: "NSW" },
  { alias: "BA", official: "Bail Act 2013", jurisdiction: "NSW" },
  { alias: "RTA", official: "Road Transport Act 2013", jurisdiction: "NSW" },
  { alias: "Road Transport Act", official: "Road Transport Act 2013", jurisdiction: "NSW" },
  { alias: "IA", official: "Interpretation Act 1987", jurisdiction: "NSW" },
  { alias: "FTA", official: "Fair Trading Act 1987", jurisdiction: "NSW", notes: "Applies the Australian Consumer Law as a law of NSW." },
  { alias: "Residential Tenancies Act", official: "Residential Tenancies Act 2010", jurisdiction: "NSW" },
  { alias: "Residential Tenancies Act", official: "Residential Tenancies Act 1997", jurisdiction: "Vic" },
  { alias: "Residential Tenancies Act", official: "Residential Tenancies and Rooming Accommodation Act 2008", jurisdiction: "Qld" },
  { alias: "ACL (Vic)", official: "Australian Consumer Law and Fair Trading Act 2012", jurisdiction: "Vic" },
  { alias: "OHS Act", official: "Occupational Health and Safety Act 2004", jurisdiction: "Vic" },
  { alias: "OMA", official: "Owners Corporations Act 2006", jurisdiction: "Vic" },
  { alias: "VCAT Act", official: "Victorian Civil and Administrative Tribunal Act 1998", jurisdiction: "Vic" },
  { alias: "QCAT Act", official: "Queensland Civil and Administrative Tribunal Act 2009", jurisdiction: "Qld" },
  { alias: "SACAT Act", official: "South Australian Civil and Administrative Tribunal Act 2013", jurisdiction: "SA" },
  { alias: "SAT Act", official: "State Administrative Tribunal Act 2004", jurisdiction: "WA" },
  { alias: "NCAT Act", official: "Civil and Administrative Tribunal Act 2013", jurisdiction: "NSW" },

  // ── Bodies used as if they were statutes (§5.4) ────────────────────────
  { alias: "ACCC", official: "Competition and Consumer Act 2010", jurisdiction: "Cth", titleId: "C2004A00109", body: true, notes: "Regulator, not a statute. Its enabling Act is the CCA." },
  { alias: "ASIC", official: "Australian Securities and Investments Commission Act 2001", jurisdiction: "Cth", titleId: "C2004A00819", body: true, notes: "Regulator. Also administers the Corporations Act 2001 (Cth)." },
  { alias: "APRA", official: "Australian Prudential Regulation Authority Act 1998", jurisdiction: "Cth", titleId: "C2004A00310", body: true, notes: "Regulator. Also administers the Banking, Insurance, Life Insurance and SIS Acts." },
  { alias: "ATO", official: "Taxation Administration Act 1953", jurisdiction: "Cth", titleId: "C1953A00001", body: true, notes: "Agency. Substantive tax law is in the ITAA 1936 and ITAA 1997." },
  { alias: "FWO", official: "Fair Work Act 2009", jurisdiction: "Cth", titleId: "C2009A00028", body: true, notes: "Fair Work Ombudsman — an agency, not a tribunal." },
  { alias: "FWC", official: "Fair Work Act 2009", jurisdiction: "Cth", titleId: "C2009A00028", body: true, notes: "Fair Work Commission — the tribunal established by the FW Act." },
  { alias: "OAIC", official: "Privacy Act 1988", jurisdiction: "Cth", titleId: "C2004A03712", body: true, notes: "Agency. Also administers the Freedom of Information Act 1982 (Cth)." },
  { alias: "ABF", official: "Customs Act 1901", jurisdiction: "Cth", titleId: "C1901A00006", body: true, notes: "Australian Border Force. Also operates under the Migration Act 1958 (Cth)." },
  { alias: "ART", official: "Administrative Review Tribunal Act 2024", jurisdiction: "Cth", titleId: "C2024A00040", body: true, notes: "Tribunal. Replaced the AAT on 14 October 2024." },
  { alias: "AAT", official: "Administrative Appeals Tribunal Act 1975", jurisdiction: "Cth", titleId: "C2004A01401", body: true, notes: "Abolished 14 October 2024; its decisions remain citable as [YYYY] AATA n." },
  { alias: "NCAT", official: "Civil and Administrative Tribunal Act 2013", jurisdiction: "NSW", body: true },
  { alias: "VCAT", official: "Victorian Civil and Administrative Tribunal Act 1998", jurisdiction: "Vic", body: true },
  { alias: "QCAT", official: "Queensland Civil and Administrative Tribunal Act 2009", jurisdiction: "Qld", body: true },
  { alias: "NACC", official: "National Anti-Corruption Commission Act 2022", jurisdiction: "Cth", titleId: "C2022A00088", body: true },
]
