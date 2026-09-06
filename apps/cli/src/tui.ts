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
import type { EngagementSnapshot, EvidenceRef, EvidenceStore } from "@cyrion/contracts"
import type { CyrionController } from "@cyrion/controller"
import {
  formatCommandHelp,
  formatEngagement,
  formatEvidence,
  formatEvidenceInspector,
  formatFindingDetail,
  formatFindings,
  formatMission,
  formatSwarm,
  formatTaskBoard,
  formatWorkerInspector,
  sanitizeTerminalText,
  type EvidenceVerification,
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
import { theme } from "./theme"

const views: ViewName[] = ["MISSION", "SWARM", "FINDINGS", "EVIDENCE"]

interface EvidencePreview {
  id?: string
  content: string
  verification: EvidenceVerification
}

export async function runTui(controller: CyrionController, evidenceStore: EvidenceStore): Promise<void> {
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
    content: t`${bold(fg(theme.accent)("▣  CYRION/AI"))}${fg(theme.dim)("  [ COMMUNITY EDITION ]")}`,
  })
  const headerMeta = new TextRenderable(renderer, {
    content: `DEMO / LAB  |  ${controller.snapshot.manifest.id}  |  ${controller.snapshot.manifest.scope.targets[0]}  |  AUTONOMOUS`,
    fg: theme.muted,
  })
  header.add(brand)
  header.add(headerMeta)

  const tabs = new BoxRenderable(renderer, { height: 3, flexDirection: "row", gap: 1 })
  const tabItems = views.map((view, index) => {
    const box = panel(renderer, { width: "25%", alignItems: "center", justifyContent: "center" })
    const label = new TextRenderable(renderer, { content: `[${index + 1}] ${view}`, fg: theme.text })
    box.add(label)
    tabs.add(box)
    return { box, label }
  })

  const body = new BoxRenderable(renderer, { flexGrow: 1, flexDirection: "row", gap: 1 })
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

  const footer = panel(renderer, { height: 3, paddingX: 1, flexDirection: "row", alignItems: "center", gap: 1 })
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

  const detailForCurrentView = (snapshot: EngagementSnapshot): StyledText => {
    if (ui.helpVisible) return formatCommandHelp()
    if (ui.activeView === "SWARM") return formatWorkerInspector(snapshot, ui.selectedTaskId)
    if (ui.activeView === "FINDINGS") return formatFindingDetail(snapshot, ui.selectedFindingId)
    return formatEngagement(snapshot)
  }

  const render = (): void => {
    const snapshot = controller.snapshot
    ui = reconcileTerminalUiState(ui, snapshot)
    for (const [index, item] of tabItems.entries()) {
      const active = views[index] === ui.activeView
      item.box.backgroundColor = active ? theme.accent : theme.panel
      item.box.borderColor = active ? theme.accentBright : theme.border
      item.label.fg = active ? theme.activeText : theme.muted
    }

    leftText.content = formatSwarm(snapshot, ui.activeView === "SWARM" ? ui.selectedTaskId : undefined)
    const isWide = renderer.width >= 120
    const isNarrow = renderer.width < 90
    const detail = detailForCurrentView(snapshot)

    if (ui.activeView === "MISSION") {
      centerText.content = formatMission(snapshot)
      rightText.content = ui.helpVisible ? formatCommandHelp() : formatEngagement(snapshot)
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
    } else {
      const reference = selectedEvidence(ui, snapshot)
      requestPreview(reference)
      const evidenceDetail = formatEvidenceInspector(snapshot, ui.selectedEvidenceId, preview.content, preview.verification)
      centerText.content = isWide
        ? formatEvidence(snapshot, ui.selectedEvidenceId)
        : stack(formatEvidence(snapshot, ui.selectedEvidenceId), evidenceDetail)
      rightText.content = ui.helpVisible ? formatCommandHelp() : evidenceDetail
    }

    if (!isWide && ui.helpVisible) centerText.content = formatCommandHelp()

    left.visible = !isNarrow
    right.visible = isWide
    center.width = isWide ? "53%" : isNarrow ? "100%" : "76%"
    headerMeta.visible = renderer.width >= 100
    shortcutText.visible = renderer.width >= 98
    shortcutText.content = ui.inputMode === "chat"
      ? "[Enter] Send  [Esc/Tab] Navigate"
      : "[↑↓] Select  [Enter] Inspect  [i] Chat  [p] Pause  [?] Help  [q] Quit"
    prompt.content = ui.inputMode === "chat" ? "root >" : "nav  >"
    prompt.fg = ui.inputMode === "chat" ? theme.accent : theme.warning
    input.placeholder = ui.inputMode === "chat"
      ? "Ask Root for a concise mission summary"
      : "Press i to ask Root about this mission"
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
    if (["1", "2", "3", "4"].includes(key.name)) {
      ui = activateView(ui, views[Number(key.name) - 1] ?? "MISSION", controller.snapshot)
      key.preventDefault()
      key.stopPropagation()
      render()
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
