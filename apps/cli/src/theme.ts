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

export const theme: CyrionTheme = colorEnabled ? colorTheme : monochromeTheme
