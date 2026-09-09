import {
  BoxRenderable,
  CliRenderEvents,
  InputRenderable,
  InputRenderableEvents,
  TextRenderable,
  bold,
  createCliRenderer,
  fg,
  t,
  type KeyEvent,
} from "@opentui/core"
import { formatLaunch } from "./format"
import {
  createLaunchState,
  editLaunchField,
  isLaunchTextField,
  launchKey,
  selectedLaunchField,
  type LaunchState,
} from "./launch-ui"
import { theme } from "./theme"
import type { ScanInput } from "./scan-config"

/**
 * The screen an operator sees before anything runs.
 *
 * It exists so that starting an assessment is a decision made once, in one
 * place, with the authorization written down — rather than a manifest assembled
 * by hand and a flag remembered from a wiki. It starts nothing itself: it
 * returns what the operator chose, and the caller builds the engagement.
 */
export async function runLaunchScreen(initial: ScanInput): Promise<ScanInput | undefined> {
  let state = createLaunchState(initial)
  let resolved: ScanInput | undefined
  const renderer = await createCliRenderer({ exitOnCtrlC: true, backgroundColor: theme.background })
  renderer.setTerminalTitle("CYRION/AI — new assessment")

  const app = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: theme.background,
  })
  const header = new BoxRenderable(renderer, {
    height: 3,
    paddingX: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: theme.background,
    borderColor: theme.accentDark,
    border: true,
  })
  header.add(new TextRenderable(renderer, {
    content: t`${bold(fg(theme.accentBright)("▣  CYRION/AI"))}${fg(theme.dim)("  [ NEW ASSESSMENT ]")}`,
  }))
  header.add(new TextRenderable(renderer, {
    content: t`${fg(theme.warning)("ONLY SCAN WHAT YOU ARE AUTHORIZED TO SCAN")}`,
  }))

  const body = new BoxRenderable(renderer, {
    flexGrow: 1,
    padding: 1,
    flexDirection: "column",
    backgroundColor: theme.background,
    borderColor: theme.accentDark,
    border: true,
  })
  const form = new TextRenderable(renderer, { content: "", fg: theme.text, flexGrow: 1, wrapMode: "word" })
  body.add(form)

  const footer = new BoxRenderable(renderer, {
    height: 3,
    paddingX: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 1,
    backgroundColor: theme.background,
    borderColor: theme.accentDark,
    border: true,
  })
  const prompt = new TextRenderable(renderer, { content: "scan >", fg: theme.accent, width: 7 })
  const input = new InputRenderable(renderer, {
    id: "launch-input",
    placeholder: "Press enter on a field to type into it",
    backgroundColor: theme.panel,
    focusedBackgroundColor: theme.panelRaised,
    textColor: theme.text,
    cursorColor: theme.text,
    flexGrow: 1,
  })
  footer.add(prompt)
  footer.add(input)

  app.add(header)
  app.add(body)
  app.add(footer)
  renderer.root.add(app)

  let editing = false
  const render = (): void => {
    form.content = formatLaunch(state, Math.max(48, renderer.terminalWidth - 6))
  }

  const beginEdit = (): void => {
    const field = selectedLaunchField(state)
    if (!isLaunchTextField(field)) return
    editing = true
    input.value = field === "target" ? state.input.target : state.input.attestation ?? ""
    input.focus()
    state = { ...state, message: "Type a value, then press enter to apply or escape to cancel." }
    render()
  }

  const endEdit = (apply: boolean): void => {
    const field = selectedLaunchField(state)
    if (apply && isLaunchTextField(field)) state = editLaunchField(state, field, input.value)
    editing = false
    input.value = ""
    input.blur()
    state = { ...state, message: undefined }
    render()
  }

  input.on(InputRenderableEvents.ENTER, () => endEdit(true))

  const onKey = (key: KeyEvent): void => {
    if (editing) {
      if (key.name === "escape" || key.name === "tab") {
        key.preventDefault()
        key.stopPropagation()
        endEdit(false)
      }
      return
    }
    const action = launchKey(state, key.name)
    if (!action) return
    if (action.kind === "state") {
      state = action.state
    } else if (action.kind === "edit") {
      beginEdit()
      return
    } else {
      // `start` carries the choice back to the caller; `cancel` carries nothing.
      if (action.kind === "start") resolved = action.input
      key.preventDefault()
      key.stopPropagation()
      renderer.destroy()
      return
    }
    key.preventDefault()
    key.stopPropagation()
    render()
  }

  renderer.keyInput.on("keypress", onKey)
  renderer.on(CliRenderEvents.RESIZE, render)
  const closed = new Promise<void>((resolve) => {
    renderer.once(CliRenderEvents.DESTROY, () => {
      renderer.keyInput.off("keypress", onKey)
      resolve()
    })
  })
  input.blur()
  render()
  await closed
  return resolved
}

export type { LaunchState }
