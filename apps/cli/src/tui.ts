import {
  BoxRenderable,
  CliRenderEvents,
  InputRenderable,
  InputRenderableEvents,
  RenderableEvents,
  StyledText,
  TextRenderable,
  bold,
  createCliRenderer,
  fg,
  t,
  type KeyEvent,
} from "@opentui/core"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { EngagementSnapshot, EvidenceRef, EvidenceStore } from "@cyrion/contracts"
import type { CyrionController } from "@cyrion/controller"
import { renderMarkdownReport } from "@cyrion/reporting"
import { inspectOpenCodeProviders, readProviderSelection } from "@cyrion/runtime-opencode"
import {
  formatCommandHelp,
  formatEngagement,
  formatEvidence,
  formatEvidenceInspector,
  formatFindingDetail,
  formatFindings,
  formatHeaderMeta,
  formatMission,
  formatSettings,
  formatSettingsInspector,
  formatSettingsSidebar,
  formatRootDispatch,
  formatSwarm,
  formatTaskBoard,
  formatWorkerInspector,
  sanitizeTerminalText,
  type EvidenceVerification,
  type RuntimeDisplay,
  type SettingsDisplay,
  type ViewName,
} from "./format"
import {
  activateView,
  createTerminalUiState,
  inspectSelection,
  isTextInputActive,
  moveSelection,
  reconcileTerminalUiState,
  selectedEvidence,
  type TerminalUiState,
  viewNavigationDelta,
} from "./navigation"
import {
  readGeneralSettings,
  saveGeneralSettings,
  type TerminalSettings,
} from "./provider-config"
import {
  adjustSetting,
  commitSettingsEditor,
  createSettingsEditor,
  editSetting,
  isTextSettingsField,
  moveSettingsSelection,
  revertSettingsEditor,
  selectedSettingsField,
  settingsAreDirty,
  valueForField,
} from "./settings-ui"
import { theme } from "./theme"

const views: ViewName[] = ["MISSION", "SWARM", "FINDINGS", "EVIDENCE", "SETTINGS"]

interface EvidencePreview {
  id?: string
  content: string
  verification: EvidenceVerification
}

export async function runTui(
  controller: CyrionController,
  evidenceStore: EvidenceStore,
  runtime: RuntimeDisplay = { mode: "fixture" },
  reportDirectory: string = join(process.cwd(), ".cyrion", "reports"),
): Promise<void> {
  const runtimeDisplay = { ...runtime }
  const generalSettings = readGeneralSettings(Bun.env)
  const providerSelection = readProviderSelection(Bun.env)
  let settingsEditor = createSettingsEditor({
    providerID: providerSelection?.providerID ?? "",
    modelID: providerSelection?.modelID ?? "",
    ...generalSettings,
  })
  let settingsDisplay: SettingsDisplay = {
    environmentPath: join(process.cwd(), ".env"),
    providers: [],
    discovery: "idle",
    message: "Open Settings to discover connected OpenCode providers.",
  }
  let providerRequest = 0
  let settingsSaving = false
  const renderer = await createCliRenderer({ exitOnCtrlC: true, backgroundColor: theme.background })
  renderer.setTerminalTitle("CYRION/AI Community")

  const app = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: theme.background,
  })
  const header = panel(renderer, { height: 3, flexDirection: "row", justifyContent: "space-between", paddingX: 1 })
  const brand = new TextRenderable(renderer, {
    content: t`${bold(fg(theme.accentBright)("▣  CYRION/AI"))}${fg(theme.dim)("  [ COMMUNITY EDITION ]")}`,
  })
  const headerMeta = new TextRenderable(renderer, { content: "", fg: theme.muted })
  const headerEnv = new TextRenderable(renderer, {
    content: t`${bold(fg(theme.accent)("DEMO / LAB"))}`,
  })
  header.add(brand)
  header.add(headerMeta)
  header.add(headerEnv)

  const tabs = new BoxRenderable(renderer, { height: 3, flexDirection: "row", gap: 1, backgroundColor: theme.background })
  const tabItems = views.map((view, index) => {
    const box = panel(renderer, { flexGrow: 1, flexBasis: 0, alignItems: "center", justifyContent: "center" })
    const label = new TextRenderable(renderer, { content: `[${index + 1}] ${view}`, fg: theme.text })
    box.add(label)
    tabs.add(box)
    return { box, label }
  })

  const body = new BoxRenderable(renderer, {
    flexGrow: 1,
    flexDirection: "row",
    gap: 1,
    backgroundColor: theme.background,
  })
  const left = panel(renderer, { width: "23%", padding: 1, flexDirection: "column" })
  // flexShrink 0: the pane title must survive a tall swarm tree.
  const leftTitle = new TextRenderable(renderer, { content: "AGENT SWARM:", fg: theme.text, flexShrink: 0 })
  const leftText = new TextRenderable(renderer, { content: "", fg: theme.muted, flexGrow: 1, wrapMode: "word" })
  left.add(leftTitle)
  left.add(leftText)

  const center = panel(renderer, { width: "53%", padding: 1, flexDirection: "column" })
  const centerText = new TextRenderable(renderer, { content: "", fg: theme.text, flexGrow: 1, wrapMode: "word" })
  center.add(centerText)

  const right = panel(renderer, { width: "24%", padding: 1, flexDirection: "column" })
  const rightText = new TextRenderable(renderer, { content: "", fg: theme.muted, flexGrow: 1, wrapMode: "word" })
  right.add(rightText)
  body.add(left)
  body.add(center)
  body.add(right)

  const footer = panel(renderer, {
    height: 3,
    paddingX: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 1,
    borderColor: theme.accentDark,
  })
  const prompt = new TextRenderable(renderer, { content: "root >", fg: theme.accent, width: 7 })
  footer.add(prompt)
  const input = new InputRenderable(renderer, {
    id: "root-input",
    placeholder: "Press i to ask Root about this mission",
    backgroundColor: theme.panel,
    focusedBackgroundColor: theme.panelRaised,
    textColor: theme.text,
    cursorColor: theme.text,
    flexGrow: 1,
  })
  footer.add(input)
  const shortcutText = new TextRenderable(renderer, { content: "", fg: theme.muted })
  footer.add(shortcutText)

  app.add(header)
  app.add(tabs)
  app.add(body)
  app.add(footer)
  renderer.root.add(app)

  let ui: TerminalUiState = createTerminalUiState(controller.snapshot)
  let preview: EvidencePreview = { content: "", verification: "idle" }
  const previewCache = new Map<string, EvidencePreview>()
  let previewRequest = 0
  let destroyed = false

  const requestPreview = (reference: EvidenceRef | undefined): void => {
    if (!reference) {
      preview = { content: "", verification: "idle" }
      return
    }
    const cached = previewCache.get(reference.uri)
    if (cached) {
      preview = cached
      return
    }
    if (preview.id === reference.id && preview.verification === "loading") return
    preview = { id: reference.id, content: "", verification: "loading" }
    const request = ++previewRequest
    void Promise.all([evidenceStore.read(reference), evidenceStore.verify(reference)])
      .then(([bytes, verified]) => {
        if (destroyed || request !== previewRequest) return
        const content = isTextArtifact(reference)
          ? sanitizeTerminalText(new TextDecoder().decode(bytes))
          : `<binary artifact: ${bytes.byteLength} bytes>`
        const loaded: EvidencePreview = {
          id: reference.id,
          content,
          verification: verified ? "verified" : "failed",
        }
        previewCache.set(reference.uri, loaded)
        preview = loaded
        render()
      })
      .catch((error: unknown) => {
        if (destroyed || request !== previewRequest) return
        preview = {
          id: reference.id,
          content: sanitizeTerminalText(error instanceof Error ? error.message : String(error)),
          verification: "failed",
        }
        render()
      })
  }

  const discoverProviders = (force = false): void => {
    if (!force && (settingsDisplay.discovery === "loading" || settingsDisplay.discovery === "ready")) return
    const request = ++providerRequest
    settingsDisplay = { ...settingsDisplay, discovery: "loading", message: "Discovering connected providers and models…" }
    render()
    const selected = settingsEditor.draft.providerID && settingsEditor.draft.modelID
      ? { providerID: settingsEditor.draft.providerID, modelID: settingsEditor.draft.modelID }
      : undefined
    void inspectOpenCodeProviders(process.cwd(), selected)
      .then((status) => {
        if (destroyed || request !== providerRequest) return
        if (status.error) {
          settingsDisplay = { ...settingsDisplay, providers: [], discovery: "failed", message: status.error }
        } else {
          settingsDisplay = {
            ...settingsDisplay,
            providers: status.connectedProviders,
            discovery: "ready",
            message: `${status.connectedProviders.length} connected provider${status.connectedProviders.length === 1 ? "" : "s"} discovered.`,
          }
        }
        render()
      })
  }

  const persistSettings = (): void => {
    if (settingsSaving) return
    if (!settingsAreDirty(settingsEditor)) {
      settingsDisplay = { ...settingsDisplay, message: "No settings changes to save." }
      render()
      return
    }
    settingsSaving = true
    settingsDisplay = { ...settingsDisplay, message: "Saving owner-only configuration…" }
    render()
    const values: TerminalSettings = { ...settingsEditor.draft }
    void saveGeneralSettings(settingsDisplay.environmentPath, values)
      .then(() => {
        if (destroyed) return
        settingsEditor = commitSettingsEditor(settingsEditor)
        process.env.CYRION_PROVIDER_ID = values.providerID
        process.env.CYRION_MODEL_ID = values.modelID
        process.env.CYRION_DEFAULT_PLANNER = values.defaultPlanner
        process.env.CYRION_DEFAULT_WORKERS = values.defaultWorkers
        process.env.CYRION_DEFAULT_MODE = values.defaultMode
        process.env.CYRION_DEFAULT_FIXTURE = values.defaultFixture
        process.env.CYRION_COLOR_MODE = values.colorMode
        settingsDisplay = { ...settingsDisplay, message: "Settings saved. Defaults apply on the next launch." }
      })
      .catch((error: unknown) => {
        if (destroyed) return
        settingsDisplay = {
          ...settingsDisplay,
          message: `Save failed: ${sanitizeTerminalText(error instanceof Error ? error.message : String(error), 160)}`,
        }
      })
      .finally(() => {
        settingsSaving = false
        if (!destroyed) render()
      })
  }

  let notice = runtimeDisplay.notice
    ? `${sanitizeTerminalText(runtimeDisplay.notice, 200)} — press 5 for Settings`
    : ""
  let exporting = false

  /** Writes the Markdown report for the current snapshot next to the local artifacts. */
  const exportReport = (): void => {
    if (exporting) return
    exporting = true
    const snapshot = controller.snapshot
    const target = join(reportDirectory, `${snapshot.manifest.id}.md`)
    notice = "Writing Markdown report…"
    render()
    void mkdir(reportDirectory, { recursive: true, mode: 0o700 })
      .then(() => writeFile(target, renderMarkdownReport(snapshot), { mode: 0o600 }))
      .then(() => {
        notice = `Report written to ${sanitizeTerminalText(target, 120)}`
      })
      .catch((error: unknown) => {
        notice = `Report export failed: ${sanitizeTerminalText(error instanceof Error ? error.message : String(error), 120)}`
      })
      .finally(() => {
        exporting = false
        if (!destroyed) render()
      })
  }

  /**
   * Pane sizing is applied on start and on resize only. Text columns come from
   * the terminal width rather than a resolved box, so the first frame and every
   * later frame agree and a rule never overruns its own border.
   */
  const paneWidth = (fraction: number): number =>
    Math.max(12, Math.floor(renderer.width * fraction) - 4)

  let layout = { isWide: true, isNarrow: false, leftWidth: 30, centerWidth: 62, rightWidth: 34 }

  const applyLayout = (): void => {
    const isWide = renderer.width >= 120
    const isNarrow = renderer.width < 90
    // Percentages leave one column for each visible gap so no pane is shrunk.
    left.visible = !isNarrow
    right.visible = isWide
    left.width = isWide ? "22%" : "23%"
    center.width = isWide ? "52%" : isNarrow ? "100%" : "76%"
    right.width = isWide ? "24%" : "0%"
    layout = {
      isWide,
      isNarrow,
      leftWidth: paneWidth(isWide ? 0.22 : 0.23),
      centerWidth: paneWidth(isWide ? 0.52 : isNarrow ? 1 : 0.76),
      rightWidth: paneWidth(0.24),
    }
  }

  const render = (): void => {
    const snapshot = controller.snapshot
    ui = reconcileTerminalUiState(ui, snapshot)
    headerMeta.content = formatHeaderMeta(snapshot)
    for (const [index, item] of tabItems.entries()) {
      const active = views[index] === ui.activeView
      const label = `[${index + 1}] ${views[index]}`
      item.box.backgroundColor = active ? theme.accent : theme.panel
      item.box.borderColor = active ? theme.accentBright : theme.border
      item.label.content = active
        ? new StyledText([bold(fg(theme.activeText)(label))])
        : new StyledText([fg(theme.muted)(label)])
    }

    const settingsActive = ui.activeView === "SETTINGS"
    const { isWide, isNarrow, leftWidth, centerWidth, rightWidth } = layout
    const help = formatCommandHelp(rightWidth)

    leftTitle.content = settingsActive ? "SYSTEM PROFILE:" : "AGENT SWARM:"
    leftText.content = settingsActive
      ? formatSettingsSidebar(settingsEditor, settingsDisplay, runtimeDisplay, leftWidth)
      : formatSwarm(snapshot, ui.activeView === "SWARM" ? ui.selectedTaskId : undefined, leftWidth)

    if (ui.activeView === "MISSION") {
      centerText.content = formatMission(snapshot, runtimeDisplay, centerWidth)
      rightText.content = ui.helpVisible ? help : formatEngagement(snapshot, runtimeDisplay, rightWidth)
    } else if (ui.activeView === "SWARM") {
      const board = formatTaskBoard(snapshot, ui.selectedTaskId, centerWidth)
      const dispatch = formatRootDispatch(snapshot, ui.selectedTaskId, rightWidth)
      centerText.content = isWide
        ? board
        : stack(board, formatWorkerInspector(snapshot, ui.selectedTaskId, centerWidth))
      rightText.content = ui.helpVisible ? help : dispatch
    } else if (ui.activeView === "FINDINGS") {
      const list = formatFindings(snapshot, ui.selectedFindingId, centerWidth)
      const detail = formatFindingDetail(snapshot, ui.selectedFindingId, rightWidth, runtimeDisplay)
      centerText.content = isWide
        ? list
        : stack(list, formatFindingDetail(snapshot, ui.selectedFindingId, centerWidth, runtimeDisplay))
      rightText.content = ui.helpVisible ? help : detail
    } else if (ui.activeView === "EVIDENCE") {
      const reference = selectedEvidence(ui, snapshot)
      requestPreview(reference)
      const index = formatEvidence(snapshot, ui.selectedEvidenceId, centerWidth)
      const detail = formatEvidenceInspector(
        snapshot,
        ui.selectedEvidenceId,
        preview.content,
        preview.verification,
        rightWidth,
      )
      centerText.content = isWide
        ? index
        : stack(index, formatEvidenceInspector(
          snapshot,
          ui.selectedEvidenceId,
          preview.content,
          preview.verification,
          centerWidth,
        ))
      rightText.content = ui.helpVisible ? help : detail
    } else {
      const editor = formatSettings(settingsEditor, settingsDisplay, centerWidth)
      const detail = formatSettingsInspector(settingsEditor, settingsDisplay, rightWidth)
      centerText.content = isWide
        ? editor
        : stack(editor, formatSettingsInspector(settingsEditor, settingsDisplay, centerWidth))
      rightText.content = ui.helpVisible ? help : detail
    }

    if (!isWide && ui.helpVisible) centerText.content = formatCommandHelp(centerWidth)

    headerMeta.visible = renderer.width >= 100
    headerEnv.visible = renderer.width >= 80
    shortcutText.visible = renderer.width >= 98
    shortcutText.content = notice
      ? new StyledText([fg(theme.accentBright)(notice)])
      : new StyledText([fg(theme.muted)(shortcutHint(ui, snapshot, settingsActive))])
    prompt.content = ui.inputMode === "chat" ? "root >" : settingsActive ? "set  >" : "root >"
    prompt.fg = ui.inputMode === "chat" ? theme.accentBright : settingsActive ? theme.warning : theme.accent
    input.placeholder = ui.inputMode === "setting"
      ? "Type a value, Enter to apply, Escape to cancel"
      : ui.inputMode === "chat"
      ? "Ask Root for a concise mission summary"
      : settingsActive ? "Use arrows to edit; press s to save" : "Press i to ask Root about this mission"
  }

  const beginSettingEdit = (): void => {
    const field = selectedSettingsField(settingsEditor)
    if (!isTextSettingsField(field)) return
    input.value = valueForField(settingsEditor.draft, field)
    ui = { ...ui, inputMode: "setting", helpVisible: false }
    input.focus()
    settingsDisplay = { ...settingsDisplay, message: "Type a value, then press Enter to apply or Escape to cancel." }
    render()
  }

  const endSettingEdit = (apply: boolean): void => {
    const field = selectedSettingsField(settingsEditor)
    if (apply && isTextSettingsField(field)) {
      settingsEditor = editSetting(settingsEditor, field, input.value)
      settingsDisplay = { ...settingsDisplay, message: "Draft updated. Press s to save or r to revert." }
    } else if (!apply) {
      settingsDisplay = { ...settingsDisplay, message: "Edit cancelled; the draft is unchanged." }
    }
    input.value = ""
    ui = { ...ui, inputMode: "dashboard" }
    input.blur()
    render()
  }

  const setChatMode = (enabled: boolean): void => {
    ui = { ...ui, inputMode: enabled ? "chat" : "dashboard", helpVisible: false }
    if (enabled) input.focus()
    else input.blur()
    render()
  }

  input.on(InputRenderableEvents.ENTER, () => {
    if (ui.inputMode === "setting") {
      endSettingEdit(true)
      return
    }
    const value = input.value.trim()
    if (value) controller.operatorMessage(value)
    input.value = ""
    setChatMode(false)
  })
  input.on(RenderableEvents.FOCUSED, () => {
    if (ui.inputMode === "chat") return
    ui = { ...ui, inputMode: "chat", helpVisible: false }
    render()
  })
  input.on(RenderableEvents.BLURRED, () => {
    if (ui.inputMode === "dashboard") return
    ui = { ...ui, inputMode: "dashboard" }
    render()
  })

  const onKeyPress = (key: KeyEvent): void => {
    if (notice && key.name !== "r") notice = ""
    if (isTextInputActive(ui.inputMode, input.focused)) {
      if (key.name === "escape" || key.name === "tab") {
        key.preventDefault()
        key.stopPropagation()
        if (ui.inputMode === "setting") endSettingEdit(false)
        else setChatMode(false)
      }
      return
    }

    if ((key.ctrl && key.name === "k") || key.name === "?") {
      ui = { ...ui, helpVisible: !ui.helpVisible }
      key.preventDefault()
      key.stopPropagation()
      render()
      return
    }
    if (["1", "2", "3", "4", "5"].includes(key.name)) {
      const view = views[Number(key.name) - 1] ?? "MISSION"
      ui = activateView(ui, view, controller.snapshot)
      key.preventDefault()
      key.stopPropagation()
      render()
      if (view === "SETTINGS") discoverProviders()
      return
    }
    if (ui.activeView === "SETTINGS" && ["up", "k", "down", "j"].includes(key.name)) {
      const delta = key.name === "up" || key.name === "k" ? -1 : 1
      settingsEditor = moveSettingsSelection(settingsEditor, delta)
      key.preventDefault()
      key.stopPropagation()
      render()
      return
    }
    if (ui.activeView === "SETTINGS" && ["left", "right"].includes(key.name)) {
      const delta = key.name === "left" ? -1 : 1
      const previous = settingsEditor
      settingsEditor = adjustSetting(settingsEditor, settingsDisplay.providers, delta)
      settingsDisplay = {
        ...settingsDisplay,
        message: settingsEditor === previous
          ? "No discovered choices are available for this setting yet."
          : "Draft updated. Press s to save or r to revert.",
      }
      key.preventDefault()
      key.stopPropagation()
      render()
      return
    }
    if (ui.activeView === "SETTINGS" && key.name === "s") {
      key.preventDefault()
      key.stopPropagation()
      persistSettings()
      return
    }
    if (ui.activeView === "SETTINGS" && key.name === "r") {
      settingsEditor = revertSettingsEditor(settingsEditor)
      settingsDisplay = { ...settingsDisplay, message: "Draft reverted to the last saved settings." }
      key.preventDefault()
      key.stopPropagation()
      render()
      return
    }
    if (ui.activeView === "SETTINGS" && key.name === "d") {
      key.preventDefault()
      key.stopPropagation()
      discoverProviders(true)
      return
    }
    const viewDelta = viewNavigationDelta(key.name, ui.activeView === "SETTINGS")
    if (viewDelta) {
      const current = views.indexOf(ui.activeView)
      const next = (current + viewDelta + views.length) % views.length
      ui = activateView(ui, views[next] ?? "MISSION", controller.snapshot)
      key.preventDefault()
      key.stopPropagation()
      render()
      if (ui.activeView === "SETTINGS") discoverProviders()
      return
    }
    if (["up", "k", "down", "j"].includes(key.name)) {
      const delta = key.name === "up" || key.name === "k" ? -1 : 1
      ui = moveSelection(ui, controller.snapshot, delta)
      key.preventDefault()
      key.stopPropagation()
      render()
      return
    }
    if (ui.activeView === "SETTINGS" && key.name === "return" && isTextSettingsField(selectedSettingsField(settingsEditor))) {
      key.preventDefault()
      key.stopPropagation()
      beginSettingEdit()
      return
    }
    if (ui.activeView === "SETTINGS" && key.name === "return") {
      const previous = settingsEditor
      settingsEditor = adjustSetting(settingsEditor, settingsDisplay.providers, 1)
      settingsDisplay = {
        ...settingsDisplay,
        message: settingsEditor === previous
          ? "No discovered choices are available for this setting yet."
          : "Draft updated. Press s to save or r to revert.",
      }
      key.preventDefault()
      key.stopPropagation()
      render()
      return
    }
    if (key.name === "return" || key.name === "e") {
      ui = inspectSelection(ui, controller.snapshot)
      key.preventDefault()
      key.stopPropagation()
      render()
      return
    }
    if (key.name === "tab" || key.name === "i") {
      key.preventDefault()
      key.stopPropagation()
      setChatMode(true)
      return
    }
    if (key.name === "a" && controller.snapshot.pendingApproval?.status === "pending") {
      controller.approvePending()
      key.preventDefault()
      key.stopPropagation()
      render()
      return
    }
    if (key.name === "x" && controller.snapshot.pendingApproval?.status === "pending") {
      controller.denyPending()
      key.preventDefault()
      key.stopPropagation()
      render()
      return
    }
    if (key.name === "r") {
      key.preventDefault()
      key.stopPropagation()
      exportReport()
      return
    }
    if (key.name === "p") {
      controller.snapshot.status === "paused" ? controller.resume() : controller.pause()
      key.preventDefault()
      key.stopPropagation()
      render()
      return
    }
    if (key.name === "q") renderer.destroy()
  }
  renderer.keyInput.on("keypress", onKeyPress)
  renderer.on(CliRenderEvents.RESIZE, () => {
    applyLayout()
    render()
  })
  let unsubscribe = (): void => {}
  const rendererDestroyed = new Promise<void>((resolve) => {
    renderer.once(CliRenderEvents.DESTROY, () => {
      destroyed = true
      renderer.keyInput.off("keypress", onKeyPress)
      unsubscribe()
      resolve()
    })
  })
  unsubscribe = controller.events.subscribe(render)
  input.blur()
  applyLayout()
  render()
  const run = controller.run()
  await rendererDestroyed
  await controller.cancel()
  await run
}

function shortcutHint(ui: TerminalUiState, snapshot: EngagementSnapshot, settingsActive: boolean): string {
  if (ui.inputMode === "chat") return "[Enter] Send   [Esc/Tab] Navigate"
  if (settingsActive) return "[↑↓] Field  [←→] Change  [s] Save  [r] Revert  [d] Discover  [q] Quit"
  if (snapshot.pendingApproval?.status === "pending") return "[a] Approve  [x] Deny  [?] Details  [q] Quit"
  return "[Tab] Focus  [Enter] Inspect  [r] Report  [p] Pause  [Ctrl+K] Commands  [q] Quit"
}

function panel(
  renderer: Awaited<ReturnType<typeof createCliRenderer>>,
  options: ConstructorParameters<typeof BoxRenderable>[1],
): BoxRenderable {
  return new BoxRenderable(renderer, {
    border: true,
    borderStyle: "single",
    borderColor: theme.border,
    backgroundColor: theme.panel,
    ...options,
  })
}

function stack(...parts: StyledText[]): StyledText {
  return new StyledText(parts.flatMap((part, index) => index ? [fg(theme.border)("\n\n"), ...part.chunks] : part.chunks))
}

function isTextArtifact(reference: EvidenceRef): boolean {
  return !reference.contentType || reference.contentType.startsWith("text/") || reference.contentType === "application/json"
}
