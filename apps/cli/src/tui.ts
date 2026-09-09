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
  formatAttack,
  formatLaunch,
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
  createLaunchState,
  editLaunchField,
  isLaunchTextField,
  launchKey,
  selectedLaunchField,
  type LaunchState,
} from "./launch-ui"
import { defaultScanInput, type ScanInput } from "./scan-config"
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
import { attackStream, scrollStream, windowOf } from "./attack-stream"
import type { EngagementSurface } from "./watch"
import { theme } from "./theme"

const views: ViewName[] = ["MISSION", "ATTACK", "SWARM", "FINDINGS", "EVIDENCE", "SETTINGS"]

interface EvidencePreview {
  id?: string
  content: string
  verification: EvidenceVerification
}

/**
 * How the terminal closed.
 *
 * `scan` is the operator starting the next assessment from Mission: the
 * terminal never starts one itself, because the engagement it is showing has to
 * be cancelled and closed first, and only the caller owns that.
 */
export type TuiExit = { kind: "closed" } | { kind: "scan"; input: ScanInput }

export async function runTui(
  controller: EngagementSurface,
  evidenceStore: EvidenceStore,
  runtime: RuntimeDisplay = { mode: "fixture" },
  reportDirectory: string = join(process.cwd(), ".cyrion", "reports"),
  launchDefaults: ScanInput = defaultScanInput,
): Promise<TuiExit> {
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
  // The next assessment, drafted under Mission. It survives a trip to another
  // view, so an operator can check a finding mid-form and come back to it.
  let launch: LaunchState = createLaunchState(launchDefaults)
  let launchOpen = false
  let exit: TuiExit = { kind: "closed" }
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

  // Rows the transcript may use, and how long it currently is: the scroll keys
  // need both, and only the renderer knows them.
  const streamHeight = (): number => Math.max(8, renderer.terminalHeight - 12)
  let streamTotal = 0
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
    // A folded pane gives its share to the centre, which is where the reading
    // happens. The terminal width still decides what can be shown at all.
    const showLeft = !isNarrow && !ui.collapsedLeft
    const showRight = isWide && !ui.collapsedRight
    const leftShare = showLeft ? (isWide ? 0.22 : 0.23) : 0
    const rightShare = showRight ? 0.24 : 0
    const centerShare = 1 - leftShare - rightShare
    left.visible = showLeft
    right.visible = showRight
    left.width = `${Math.round(leftShare * 100)}%`
    center.width = `${Math.round(centerShare * 100)}%`
    right.width = `${Math.round(rightShare * 100)}%`
    layout = {
      isWide,
      isNarrow,
      leftWidth: paneWidth(leftShare || 0.22),
      centerWidth: paneWidth(centerShare),
      rightWidth: paneWidth(rightShare || 0.24),
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

    leftTitle.content = `${settingsActive ? "SYSTEM PROFILE:" : "AGENT SWARM:"}  [-]`
    leftText.content = settingsActive
      ? formatSettingsSidebar(settingsEditor, settingsDisplay, runtimeDisplay, leftWidth)
      : formatSwarm(snapshot, ui.activeView === "SWARM" ? ui.selectedTaskId : undefined, leftWidth)

    if (ui.activeView === "MISSION") {
      centerText.content = launchOpen
        ? formatLaunch(launch, centerWidth, launchNote(snapshot))
        : formatMission(snapshot, runtimeDisplay, centerWidth)
      rightText.content = ui.helpVisible ? help : formatEngagement(snapshot, runtimeDisplay, rightWidth)
    } else if (ui.activeView === "ATTACK") {
      // Two lines per entry at worst, so the window asks for half the rows.
      const lines = attackStream(snapshot)
      const view = windowOf(lines, {
        height: Math.max(4, Math.floor(streamHeight() / 2)),
        offset: ui.streamOffset,
        following: ui.streamFollowing,
      })
      streamTotal = view.total
      centerText.content = formatAttack(snapshot, view, centerWidth)
      rightText.content = ui.helpVisible ? help : formatEngagement(snapshot, runtimeDisplay, rightWidth)
    } else if (ui.activeView === "SWARM") {
      const board = formatTaskBoard(snapshot, ui.selectedTaskId, centerWidth)
      const dispatch = formatRootDispatch(snapshot, ui.selectedTaskId, rightWidth)
      centerText.content = isWide
        ? board
        : stack(board, formatWorkerInspector(snapshot, ui.selectedTaskId, centerWidth))
      rightText.content = ui.helpVisible ? help : dispatch
    } else if (ui.activeView === "FINDINGS") {
      const list = formatFindings(snapshot, ui.selectedFindingId, centerWidth, ui.findingFilter)
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
    const launchActive = launchOpen && ui.activeView === "MISSION"
    shortcutText.content = notice
      ? new StyledText([fg(theme.accentBright)(notice)])
      : new StyledText([fg(theme.muted)(shortcutHint(ui, snapshot, settingsActive, launchActive))])
    prompt.content = launchActive ? "scan >" : settingsActive ? "set  >" : "root >"
    prompt.fg = launchActive
      ? theme.accentBright
      : ui.inputMode === "chat" ? theme.accentBright : settingsActive ? theme.warning : theme.accent
    input.placeholder = ui.inputMode === "filter"
      ? "Filter findings by id, title, asset, verdict, severity, or skill"
      : ui.inputMode === "setting" || ui.inputMode === "launch"
      ? "Type a value, Enter to apply, Escape to cancel"
      : ui.inputMode === "chat"
      ? "Ask Root for a concise mission summary"
      : launchActive
      ? "Fill the assessment in; press s to start it"
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

  /** Opens the footer editor for the target or the attestation. */
  const beginLaunchEdit = (): void => {
    const field = selectedLaunchField(launch)
    if (!isLaunchTextField(field)) return
    input.value = field === "target" ? launch.input.target : launch.input.attestation ?? ""
    ui = { ...ui, inputMode: "launch", helpVisible: false }
    input.focus()
    launch = { ...launch, message: "Type a value, then press Enter to apply or Escape to cancel." }
    render()
  }

  const endLaunchEdit = (apply: boolean): void => {
    const field = selectedLaunchField(launch)
    if (apply && isLaunchTextField(field)) launch = editLaunchField(launch, field, input.value)
    launch = { ...launch, message: undefined }
    input.value = ""
    ui = { ...ui, inputMode: "dashboard" }
    input.blur()
    render()
  }

  /**
   * Hands the operator's next assessment back to the caller.
   *
   * Closing the renderer is what cancels this engagement, so the new one never
   * starts while the old one still holds leases, artifacts, and a state file.
   */
  const startLaunch = (chosen: ScanInput): void => {
    exit = { kind: "scan", input: chosen }
    renderer.destroy()
  }

  const endFilter = (apply: boolean): void => {
    const findingFilter = apply ? input.value.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim().slice(0, 120) : ui.findingFilter
    input.value = ""
    input.blur()
    // The selection may no longer be in the list, so let reconciliation pick one.
    ui = reconcileTerminalUiState({ ...ui, inputMode: "dashboard", findingFilter }, controller.snapshot)
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
    if (ui.inputMode === "launch") {
      endLaunchEdit(true)
      return
    }
    if (ui.inputMode === "filter") {
      endFilter(true)
      return
    }
    const value = input.value.trim()
    if (value) controller.operatorMessage(value)
    input.value = ""
    setChatMode(false)
  })
  input.on(RenderableEvents.FOCUSED, () => {
    // Only an unclaimed footer becomes chat: a settings or launch field focuses
    // the same input, and sending its value to Root is not what was asked.
    if (ui.inputMode !== "dashboard") return
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
        else if (ui.inputMode === "launch") endLaunchEdit(false)
        else if (ui.inputMode === "filter") endFilter(false)
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
    if (["1", "2", "3", "4", "5", "6"].includes(key.name)) {
      const view = views[Number(key.name) - 1] ?? "MISSION"
      ui = activateView(ui, view, controller.snapshot)
      key.preventDefault()
      key.stopPropagation()
      render()
      if (view === "SETTINGS") discoverProviders()
      return
    }
    // The assessment form owns the keyboard while it is open, so a key meant
    // for a field cannot pause the run or export a report behind it. Moving
    // between views still works: `1`–`6` above, `[` and `]` below.
    if (launchOpen && ui.activeView === "MISSION" && key.name !== "[" && key.name !== "]") {
      const action = launchKey(launch, key.name)
      key.preventDefault()
      key.stopPropagation()
      if (action?.kind === "edit") {
        beginLaunchEdit()
        return
      }
      if (action?.kind === "start") {
        startLaunch(action.input)
        return
      }
      if (action?.kind === "state") launch = action.state
      else if (action?.kind === "cancel") launchOpen = false
      render()
      return
    }
    if (ui.activeView === "MISSION" && key.name === "n") {
      launchOpen = true
      ui = { ...ui, helpVisible: false }
      key.preventDefault()
      key.stopPropagation()
      render()
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
    if (key.name === "<" || key.name === ",") {
      ui = { ...ui, collapsedLeft: !ui.collapsedLeft }
      applyLayout()
      key.preventDefault()
      key.stopPropagation()
      render()
      return
    }
    if (key.name === ">" || key.name === ".") {
      ui = { ...ui, collapsedRight: !ui.collapsedRight }
      applyLayout()
      key.preventDefault()
      key.stopPropagation()
      render()
      return
    }
    if (ui.activeView === "FINDINGS" && key.name === "/") {
      ui = { ...ui, inputMode: "filter", helpVisible: false }
      input.value = ui.findingFilter
      input.focus()
      key.preventDefault()
      key.stopPropagation()
      render()
      return
    }
    if (ui.activeView === "FINDINGS" && key.name === "escape" && ui.findingFilter) {
      ui = reconcileTerminalUiState({ ...ui, findingFilter: "" }, controller.snapshot)
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
    if (ui.activeView === "ATTACK" && ["up", "k", "down", "j", "pageup", "pagedown", "home", "end", "f"].includes(key.name)) {
      const height = Math.max(4, Math.floor(streamHeight() / 2))
      if (key.name === "f") {
        ui = { ...ui, streamFollowing: !ui.streamFollowing }
      } else if (key.name === "home") {
        ui = { ...ui, streamOffset: 0, streamFollowing: false }
      } else if (key.name === "end") {
        ui = { ...ui, streamFollowing: true }
      } else {
        const delta = key.name === "up" || key.name === "k" ? -1 : key.name === "down" || key.name === "j" ? 1
          : key.name === "pageup" ? -height : height
        const moved = scrollStream(
          { offset: ui.streamOffset, following: ui.streamFollowing },
          delta,
          streamTotal,
          height,
        )
        ui = { ...ui, streamOffset: moved.offset, streamFollowing: moved.following }
      }
      key.preventDefault()
      key.stopPropagation()
      render()
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
  return exit
}

function shortcutHint(
  ui: TerminalUiState,
  snapshot: EngagementSnapshot,
  settingsActive: boolean,
  launchActive: boolean,
): string {
  if (ui.inputMode === "chat") return "[Enter] Send   [Esc/Tab] Navigate"
  if (launchActive) return "[↑↓] Field  [←→] Change  [space] Toggle  [s] Start  [Esc] Back"
  if (settingsActive) return "[↑↓] Field  [←→] Change  [s] Save  [r] Revert  [d] Discover  [q] Quit"
  if (snapshot.pendingApproval?.status === "pending") return "[a] Approve  [x] Deny  [?] Details  [q] Quit"
  if (ui.activeView === "MISSION") {
    return "[n] New scan  [Tab] Focus  [r] Report  [p] Pause  [Ctrl+K] Commands  [q] Quit"
  }
  return "[Tab] Focus  [Enter] Inspect  [r] Report  [p] Pause  [Ctrl+K] Commands  [q] Quit"
}

/** What starting another assessment does to the one on screen. */
function launchNote(snapshot: EngagementSnapshot): string {
  return snapshot.status === "running" || snapshot.status === "paused"
    ? "Starting this assessment cancels the engagement running here; its record and artifacts stay on disk."
    : "This engagement has finished. Its record and artifacts stay on disk."
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
