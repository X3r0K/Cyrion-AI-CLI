/**
 * Escaping for every export format.
 *
 * Finding text is derived from what a target returned, so it is untrusted in
 * every renderer: control characters are stripped once here, and each format
 * escapes for its own grammar rather than trusting the one before it.
 */

/** Removes control characters that would drive a terminal or corrupt a file. */
export function clean(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "")
}

/** Safe inside a Markdown table cell or inline span. */
export function inline(value: string): string {
  return clean(value).replaceAll("`", "\\`").replaceAll("|", "\\|").replaceAll("\n", " ")
}

export function paragraph(value: string): string {
  return clean(value).replaceAll("\n", " ")
}

/** Escapes text for HTML body content and attribute values alike. */
export function escapeHtml(value: string): string {
  return clean(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

/**
 * Escapes text for XML content. Characters XML 1.0 cannot represent at all —
 * not even as a reference — are dropped rather than emitted as invalid markup.
 */
export function escapeXml(value: string): string {
  return clean(value)
    .replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD]/g, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

/**
 * One RFC 4180 field.
 *
 * A leading `=`, `+`, `-`, or `@` is prefixed with a quote, because a
 * spreadsheet treats those as formulas and a finding summary is attacker-
 * influenced text.
 */
export function csvField(value: string): string {
  const text = clean(value).replaceAll("\r\n", "\n")
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return `"${guarded.replaceAll('"', '""')}"`
}

export function csvRow(values: readonly string[]): string {
  return values.map(csvField).join(",")
}
