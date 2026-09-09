import { describe, expect, test } from "bun:test"
import { resolveTheme, themeNames, themes, type CyrionTheme } from "../apps/cli/src/theme"

/** Relative luminance, for the contrast ratio a reader actually experiences. */
function luminance(hex: string): number {
  const clean = hex.replace("#", "").slice(0, 6)
  const channels = [0, 2, 4].map((offset) => {
    const value = parseInt(clean.slice(offset, offset + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
}

function contrast(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (light! + 0.05) / (dark! + 0.05)
}

describe("choosing a theme", () => {
  test("names a theme, falls back rather than failing on an unknown one", () => {
    expect(resolveTheme("ember").name).toBe("ember")
    expect(resolveTheme("GLACIER").name).toBe("glacier")
    // A typo in an environment variable should not stop a terminal opening.
    expect(resolveTheme("chartreuse").name).toBe("cyrion")
    expect(resolveTheme(undefined).name).toBe("cyrion")
  })

  test("a terminal that asked for no colour means it", () => {
    // NO_COLOR wins over a named theme, whatever the name was.
    expect(resolveTheme("ember", false).name).toBe("monochrome")
    expect(resolveTheme(undefined, false).name).toBe("monochrome")
  })
})

describe("every theme stays readable", () => {
  const entries = Object.entries(themes) as Array<[string, CyrionTheme]>

  test("body text clears 7:1 against the panel it sits on", () => {
    for (const [name, palette] of entries) {
      const ratio = contrast(palette.text, palette.panel)
      expect(`${name}:${ratio.toFixed(1)}`).toBe(`${name}:${Math.max(ratio, 7).toFixed(1)}`)
    }
  })

  test("muted text is dimmer than body text but still legible", () => {
    for (const [name, palette] of entries) {
      const muted = contrast(palette.muted, palette.panel)
      const body = contrast(palette.text, palette.panel)
      expect(`${name}:${muted < body}`).toBe(`${name}:true`)
      // Dim is a de-emphasis, not an invitation to squint.
      expect(`${name}:${muted >= 3}`).toBe(`${name}:true`)
    }
  })

  test("the state colours are distinguishable from one another", () => {
    for (const [name, palette] of entries) {
      if (name === "monochrome") continue
      // A running agent, a warning and a failure must never read the same in a
      // tree twenty lines deep.
      const states = [palette.accent, palette.warning, palette.danger, palette.success]
      expect(`${name}:${new Set(states).size}`).toBe(`${name}:4`)
    }
  })

  test("monochrome carries no perceptible hue, so NO_COLOR is honest", () => {
    // Not pure grey: a neutral with a slight cool bias reads as chosen rather
    // than as an absence. What matters is that no channel carries a signal —
    // a spread this small is invisible, so nothing is encoded in colour.
    const mono = themes.monochrome
    for (const [token, value] of Object.entries(mono)) {
      const clean = value.replace("#", "").slice(0, 6)
      const channels = [0, 2, 4].map((offset) => parseInt(clean.slice(offset, offset + 2), 16))
      const spread = Math.max(...channels) - Math.min(...channels)
      expect(`${token}:${spread <= 16}`).toBe(`${token}:true`)
    }
  })

  test("every theme defines every token", () => {
    const tokens = Object.keys(themes.cyrion) as Array<keyof CyrionTheme>
    for (const name of themeNames) {
      for (const token of tokens) {
        expect(`${name}.${token}`).toBe(`${name}.${themes[name][token] ? token : "MISSING"}`)
      }
    }
  })
})
