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
import type { CyrionController } from "@cyrion/controller"
import {
  formatEngagement,
  formatEvidence,
  formatFindingDetail,
  formatFindings,
  formatMission,
  formatSwarm,
  formatTaskBoard,
  type ViewName,
} from "./format"
import { theme } from "./theme"

const views: ViewName[] = ["MISSION", "SWARM", "FINDINGS", "EVIDENCE"]

export async function runTui(controller: CyrionController): Promise<void> {
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
  const leftText = new TextRenderable(renderer, { content: "", fg: theme.muted, flexGrow: 1 })
  left.add(leftTitle)
  left.add(leftText)

  const center = panel(renderer, { width: "53%", padding: 1, flexDirection: "column" })
  const centerText = new TextRenderable(renderer, { content: "", fg: theme.text, flexGrow: 1 })
  center.add(centerText)

  const right = panel(renderer, { width: "24%", padding: 1, flexDirection: "column" })
  const rightText = new TextRenderable(renderer, { content: "", fg: theme.muted, flexGrow: 1 })
  right.add(rightText)
  body.add(left)
  body.add(center)
  body.add(right)

  const footer = panel(renderer, { height: 3, paddingX: 1, flexDirection: "row", alignItems: "center", gap: 1 })
  footer.add(new TextRenderable(renderer, { content: "root >", fg: theme.accent, width: 7 }))
  const input = new InputRenderable(renderer, {
    id: "root-input",
    placeholder: "Summarize the current mission status",
    backgroundColor: theme.panel,
    focusedBackgroundColor: theme.panelRaised,
    textColor: theme.text,
    cursorColor: theme.text,
    flexGrow: 1,
  })
  footer.add(input)
  footer.add(new TextRenderable(renderer, {
    content: "[1-4] View  [p] Pause  [Enter] Send  [q] Quit",
    fg: theme.muted,
  }))

  app.add(header)
  app.add(tabs)
  app.add(body)
  app.add(footer)
  renderer.root.add(app)

  let activeView: ViewName = "MISSION"
  const render = (): void => {
    const snapshot = controller.snapshot
    for (const [index, item] of tabItems.entries()) {
      const active = views[index] === activeView
      item.box.backgroundColor = active ? theme.accent : theme.panel
      item.box.borderColor = active ? theme.accentBright : theme.border
      item.label.fg = active ? theme.activeText : theme.muted
    }
    leftText.content = formatSwarm(snapshot)
    if (activeView === "MISSION") {
      centerText.content = formatMission(snapshot)
      rightText.content = formatEngagement(snapshot)
    } else if (activeView === "SWARM") {
      centerText.content = formatTaskBoard(snapshot)
      rightText.content = t`${bold(fg(theme.text)("ROOT DISPATCH"))}
${fg(theme.border)("────────────────────────────")}
${fg(theme.accent)("■ ROOT OWNS THE PLAN")}
${fg(theme.dim)("Parallel slots  ")}${fg(theme.text)(snapshot.manifest.budgets.maxConcurrentAgents)}
${fg(theme.dim)("Queued tasks    ")}${fg(theme.warning)(snapshot.tasks.filter((task) => task.status === "queued").length)}
${fg(theme.dim)("Completed       ")}${fg(theme.success)(snapshot.tasks.filter((task) => task.status === "completed").length)}

${fg(theme.accent)("──────── LAST HANDOFF ────────")}
${fg(theme.text)(snapshot.tasks.at(-1)?.objective ?? "Waiting for dispatch")}

${fg(theme.success)("■ SCOPE ENFORCED")}
${fg(theme.success)("■ EVENT STREAM HEALTHY")}`
    } else if (activeView === "FINDINGS") {
      centerText.content = formatFindings(snapshot)
      rightText.content = formatFindingDetail(snapshot)
    } else {
      centerText.content = formatEvidence(snapshot)
      rightText.content = formatEngagement(snapshot)
    }
    const wide = renderer.width >= 120
    right.visible = wide
    center.width = wide ? "53%" : "77%"
    headerMeta.visible = renderer.width >= 100
  }

  input.on(InputRenderableEvents.ENTER, () => {
    const value = input.value.trim()
    if (value) controller.operatorMessage(value)
    input.value = ""
    render()
  })

  const onKeyPress = (key: KeyEvent): void => {
    if (["1", "2", "3", "4"].includes(key.name)) {
      activeView = views[Number(key.name) - 1] ?? "MISSION"
      key.stopPropagation()
      render()
      return
    }
    if (key.name === "p") {
      controller.snapshot.status === "paused" ? controller.resume() : controller.pause()
      key.stopPropagation()
      render()
      return
    }
    if (key.name === "q" && !input.value) renderer.destroy()
  }
  renderer.keyInput.on("keypress", onKeyPress)
  renderer.on(CliRenderEvents.RESIZE, render)
  renderer.once(CliRenderEvents.DESTROY, () => renderer.keyInput.off("keypress", onKeyPress))
  controller.events.subscribe(render)
  input.focus()
  render()
  void controller.run().then(render)
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
