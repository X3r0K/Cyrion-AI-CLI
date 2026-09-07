import { describe, expect, test } from "bun:test"
import { parseStrictStructuredText } from "@cyrion/runtime-opencode"

describe("OpenCode structured-output compatibility", () => {
  test("accepts one bare JSON object assembled from text parts", () => {
    expect(parseStrictStructuredText([
      { type: "text", text: "{\"verdict\":" },
      { type: "reasoning", text: "ignored" },
      { type: "text", text: "\"accept\",\"rationale\":\"bounded\"}" },
    ])).toEqual({ verdict: "accept", rationale: "bounded" })
  })

  test("rejects Markdown wrappers, commentary, ignored text, and malformed JSON", () => {
    expect(parseStrictStructuredText([{ type: "text", text: "```json\n{\"ok\":true}\n```" }])).toBeUndefined()
    expect(parseStrictStructuredText([{ type: "text", text: "result: {\"ok\":true}" }])).toBeUndefined()
    expect(parseStrictStructuredText([{ type: "text", text: "{bad}" }])).toBeUndefined()
    expect(parseStrictStructuredText([{ type: "text", text: "{\"ignored\":true}", ignored: true }])).toBeUndefined()
  })
})
