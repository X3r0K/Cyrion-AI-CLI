import {
  BoxRenderable,
  CliRenderEvents,
  InputRenderable,
  InputRenderableEvents,
  StyledText,
  TextRenderable,
  bold,
  createCliRenderer,
  fg,
  t,
  type KeyEvent,
} from "@opentui/core"
import { join } from "node:path"
import type { EngagementSnapshot, EvidenceRef, EvidenceStore } from "@cyrion/contracts"
import type { CyrionController } from "@cyrion/controller"
import { inspectOpenCodeProviders, readProviderSelection } from "@cyrion/runtime-opencode"
import {
  formatCommandHelp,
  formatEngagement,
  formatEvidence,
  formatEvidenceInspector,
  formatFindingDetail,
  formatFindings,
  formatMission,
  formatSettings,
  formatSettingsInspector,
  formatSettingsSidebar,
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
  moveSelection,
  reconcileTerminalUiState,
  selectedEvidence,
  type TerminalUiState,
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
  moveSettingsSelection,
  revertSettingsEditor,
  settingsAreDirty,
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
): Promise<void> {
  let runtimeDisplay = { ...runtime }
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
  const headerMeta = new TextRenderable(renderer, {
    content: "",
    fg: theme.muted,
  })
  header.add(brand)
  header.add(headerMeta)

  const tabs = new BoxRenderable(renderer, { height: 3, flexDirection: "row", gap: 1, backgroundColor: theme.background })
  const tabItems = views.map((view, index) => {
    const box = panel(renderer, { width: "20%", alignItems: "center", justifyContent: "center" })
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
  const leftTitle = new TextRenderable(renderer, { content: "AGENT SWARM:", fg: theme.text })
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
        process.env.CYRION_DEFAULT_MODE = values.defaultMode
        process.env.CYRION_DEFAULT_FIXTURE = values.defaultFixture
        process.env.CYRION_COLOR_MODE = values.colorMode
        runtimeDisplay = values.providerID && values.modelID
          ? { ...runtimeDisplay, provider: `${values.providerID}/${values.modelID} (CONFIGURED)` }
          : { mode: runtimeDisplay.mode }
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

  const detailForCurrentView = (snapshot: EngagementSnapshot): StyledText => {
    if (ui.helpVisible) return formatCommandHelp()
    if (ui.activeView === "SWARM") return formatWorkerInspector(snapshot, ui.selectedTaskId)
    if (ui.activeView === "FINDINGS") return formatFindingDetail(snapshot, ui.selectedFindingId)
    if (ui.activeView === "SETTINGS") return formatSettingsInspector(settingsEditor, settingsDisplay)
    return formatEngagement(snapshot, runtimeDisplay)
  }

  const render = (): void => {
    const snapshot = controller.snapshot
    ui = reconcileTerminalUiState(ui, snapshot)
    headerMeta.content = `DEMO / LAB  |  ${snapshot.manifest.id}  |  ${runtimeDisplay.mode.toUpperCase()}  |  LLM ${runtimeDisplay.provider ?? "NOT CONFIGURED"}`
    for (const [index, item] of tabItems.entries()) {
      const active = views[index] === ui.activeView
      item.box.backgroundColor = active ? theme.accent : theme.panel
      item.box.borderColor = active ? theme.accentBright : theme.border
      item.label.fg = active ? theme.activeText : theme.muted
    }

    const settingsActive = ui.activeView === "SETTINGS"
    leftTitle.content = settingsActive ? "SYSTEM PROFILE:" : "AGENT SWARM:"
    leftText.content = settingsActive
      ? formatSettingsSidebar(settingsEditor, settingsDisplay, runtimeDisplay)
      : formatSwarm(snapshot, ui.activeView === "SWARM" ? ui.selectedTaskId : undefined)
    const isWide = renderer.width >= 120
    const isNarrow = renderer.width < 90
    const detail = detailForCurrentView(snapshot)

    if (ui.activeView === "MISSION") {
      centerText.content = formatMission(snapshot, runtimeDisplay)
      rightText.content = ui.helpVisible ? formatCommandHelp() : formatEngagement(snapshot, runtimeDisplay)
    } else if (ui.activeView === "SWARM") {
      centerText.content = isWide
        ? formatTaskBoard(snapshot, ui.selectedTaskId)
        : stack(formatTaskBoard(snapshot, ui.selectedTaskId), detail)
      rightText.content = ui.helpVisible ? formatCommandHelp() : detail
    } else if (ui.activeView === "FINDINGS") {
      centerText.content = isWide
        ? formatFindings(snapshot, ui.selectedFindingId)
        : stack(formatFindings(snapshot, ui.selectedFindingId), detail)
      rightText.content = ui.helpVisible ? formatCommandHelp() : detail
    } else if (ui.activeView === "EVIDENCE") {
      const reference = selectedEvidence(ui, snapshot)
      requestPreview(reference)
      const evidenceDetail = formatEvidenceInspector(snapshot, ui.selectedEvidenceId, preview.content, preview.verification)
      centerText.content = isWide
        ? formatEvidence(snapshot, ui.selectedEvidenceId)
        : stack(formatEvidence(snapshot, ui.selectedEvidenceId), evidenceDetail)
      rightText.content = ui.helpVisible ? formatCommandHelp() : evidenceDetail
    } else {
      const settingsDetail = formatSettingsInspector(settingsEditor, settingsDisplay)
      centerText.content = isWide
        ? formatSettings(settingsEditor, settingsDisplay)
        : stack(formatSettings(settingsEditor, settingsDisplay), settingsDetail)
      rightText.content = ui.helpVisible ? formatCommandHelp() : settingsDetail
    }

    if (!isWide && ui.helpVisible) centerText.content = formatCommandHelp()

    left.visible = !isNarrow
    right.visible = isWide
    center.width = isWide ? "53%" : isNarrow ? "100%" : "76%"
    headerMeta.visible = renderer.width >= 100
    shortcutText.visible = renderer.width >= 98
    shortcutText.content = ui.inputMode === "chat"
      ? "[Enter] Send  [Esc/Tab] Navigate"
      : settingsActive
        ? "[↑↓] Field  [←→] Change  [s] Save  [r] Revert  [d] Discover  [q] Quit"
      : snapshot.pendingApproval?.status === "pending"
        ? "[a] Approve  [x] Deny  [?] Details  [q] Quit"
        : "[↑↓] Select  [Enter] Inspect  [i] Chat  [p] Pause  [?] Help  [q] Quit"
    prompt.content = ui.inputMode === "chat" ? "root >" : settingsActive ? "set  >" : "nav  >"
    prompt.fg = ui.inputMode === "chat" ? theme.accent : settingsActive ? theme.accentBright : theme.warning
    input.placeholder = ui.inputMode === "chat"
      ? "Ask Root for a concise mission summary"
      : settingsActive ? "Use arrows to edit; press s to save" : "Press i to ask Root about this mission"
  }

  const setChatMode = (enabled: boolean): void => {
    ui = { ...ui, inputMode: enabled ? "chat" : "dashboard", helpVisible: false }
    if (enabled) input.focus()
    else input.blur()
    render()
  }

  input.on(InputRenderableEvents.ENTER, () => {
    const value = input.value.trim()
    if (value) controller.operatorMessage(value)
    input.value = ""
    setChatMode(false)
  })

  const onKeyPress = (key: KeyEvent): void => {
    if (ui.inputMode === "chat") {
      if (key.name === "escape" || key.name === "tab") {
        key.preventDefault()
        key.stopPropagation()
        setChatMode(false)
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
    if (["left", "h", "right", "l"].includes(key.name)) {
      const delta = key.name === "left" || key.name === "h" ? -1 : 1
      const current = views.indexOf(ui.activeView)
      const next = (current + delta + views.length) % views.length
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
  renderer.on(CliRenderEvents.RESIZE, render)
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
  render()
  const run = controller.run()
  await rendererDestroyed
  await controller.cancel()
  await run
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
