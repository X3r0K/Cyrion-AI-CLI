const colorEnabled = process.env.NO_COLOR === undefined

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
  background: "#070C0E",
  panel: "#0D1517",
  panelRaised: "#111B1D",
  selection: "#123536",
  border: "#34494C",
  borderMuted: "#243639",
  accent: "#00D2BA",
  accentBright: "#07DCCD",
  accentDark: "#063F3C",
  activeText: "#061011",
  text: "#F4F7F9",
  muted: "#A8B2B7",
  dim: "#7F8E92",
  warning: "#F8C038",
  danger: "#FF7068",
  success: "#58D080",
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

export const theme: CyrionTheme = colorEnabled ? colorTheme : monochromeTheme
