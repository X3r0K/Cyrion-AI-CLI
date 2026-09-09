/**
 * The terminal's palette.
 *
 * One token set, several dressings. Colour here is doing work rather than
 * decoration: a running agent, a validator verifying, a refusal and a critical
 * finding have to be distinguishable at a glance in a tree that may be twenty
 * lines deep, and an operator watching someone else's screen should be able to
 * pick the same signals out.
 *
 * `CYRION_THEME` chooses one; `NO_COLOR` and `CYRION_COLOR_MODE=monochrome`
 * still win, because a terminal that asked for no colour meant it.
 */

const configuredColorMode = process.env.CYRION_COLOR_MODE?.trim()
const colorEnabled = configuredColorMode === "color"
  || (configuredColorMode !== "monochrome" && process.env.NO_COLOR === undefined)

export interface CyrionTheme {
  background: string
  panel: string
  panelRaised: string
  selection: string
  border: string
  borderMuted: string
  accent: string
  accentBright: string
  accentDark: string
  activeText: string
  text: string
  muted: string
  dim: string
  warning: string
  danger: string
  success: string
}

const colorTheme: CyrionTheme = {
  background: "#020709E8",
  panel: "#071114C4",
  panelRaised: "#0A1A1DDE",
  selection: "#06413FCC",
  border: "#245158D9",
  borderMuted: "#17343AB8",
  accent: "#00E8D0",
  accentBright: "#32FFE7",
  accentDark: "#064E4A",
  activeText: "#02090A",
  text: "#F0F4F2",
  muted: "#A6B8BB",
  dim: "#71878B",
  warning: "#F4C95D",
  danger: "#FF6577",
  success: "#63DC8C",
}

const monochromeTheme: CyrionTheme = {
  background: "#080B0C",
  panel: "#101415",
  panelRaised: "#171C1D",
  selection: "#283032",
  border: "#667174",
  borderMuted: "#343C3E",
  accent: "#F4F7F9",
  accentBright: "#F4F7F9",
  accentDark: "#343C3E",
  activeText: "#080B0C",
  text: "#F4F7F9",
  muted: "#C2C8CB",
  dim: "#929B9F",
  warning: "#E0E4E6",
  danger: "#F4F7F9",
  success: "#F4F7F9",
}

/** Warmer, lower-contrast: a long engagement read on a bright screen. */
const emberTheme: CyrionTheme = {
  background: "#0B0705E8",
  panel: "#161009C4",
  panelRaised: "#1F160CDE",
  selection: "#4A2A0BCC",
  border: "#5A3D1DD9",
  borderMuted: "#3A2712B8",
  accent: "#FFA94D",
  accentBright: "#FFD08A",
  accentDark: "#5A3308",
  activeText: "#120A03",
  text: "#F7F0E8",
  muted: "#C4B3A2",
  dim: "#8C7A68",
  warning: "#FFD43B",
  danger: "#FF7A6B",
  success: "#A9E34B",
}

/** Cool and high-contrast, for a projector or a shared screen. */
const glacierTheme: CyrionTheme = {
  background: "#04070CE8",
  panel: "#0A1120C4",
  panelRaised: "#101A2FDE",
  selection: "#123A66CC",
  border: "#1F4A7AD9",
  borderMuted: "#153350B8",
  accent: "#4DA3FF",
  accentBright: "#8AC7FF",
  accentDark: "#0B3A66",
  activeText: "#03060B",
  text: "#EEF4FF",
  muted: "#A8BCD6",
  dim: "#6F87A3",
  warning: "#FFC65C",
  danger: "#FF6B8A",
  success: "#5BE0A5",
}

export const themes = {
  cyrion: colorTheme,
  ember: emberTheme,
  glacier: glacierTheme,
  monochrome: monochromeTheme,
} as const

export type ThemeName = keyof typeof themes

export const themeNames = Object.keys(themes) as ThemeName[]

/** The theme this terminal will use, and why. An unknown name falls back rather than fails. */
export function resolveTheme(
  name: string | undefined,
  colored = colorEnabled,
): { theme: CyrionTheme; name: ThemeName } {
  if (!colored) return { theme: monochromeTheme, name: "monochrome" }
  const requested = name?.trim().toLowerCase()
  if (requested && requested in themes) {
    return { theme: themes[requested as ThemeName], name: requested as ThemeName }
  }
  return { theme: colorTheme, name: "cyrion" }
}

const resolved = resolveTheme(process.env.CYRION_THEME)

export const theme: CyrionTheme = resolved.theme
export const activeThemeName: ThemeName = resolved.name
