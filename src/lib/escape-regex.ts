/**
 * Escape regular-expression metacharacters — run user or upstream strings
 * through this before splicing them into a pattern.
 *
 * Act titles, schedule names and case-law keywords routinely carry parentheses
 * (`Crimes Act 1900 (NSW)`, `Schedule 2 (see section 91)`); dropped straight
 * into `new RegExp` they become capture groups and matching silently drifts.
 * There must be exactly one copy of the escape character set, so it lives here.
 */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
