import type { EngagementSnapshot, EvidenceRef, Finding, TaskRecord } from "@cyrion/contracts"
import type { ViewName } from "./format"

/** `setting` is chat's sibling: the footer input edits one settings field. */
export type InputMode = "dashboard" | "chat" | "setting"

export function isTextInputActive(mode: InputMode, inputFocused: boolean): boolean {
  return mode === "chat" || mode === "setting" || inputFocused
}

export function viewNavigationDelta(key: string, settingsActive: boolean): -1 | 1 | undefined {
  if (key === "[") return -1
  if (key === "]") return 1
  if (!settingsActive && key === "left") return -1
  if (!settingsActive && key === "right") return 1
  return undefined
}

export interface TerminalUiState {
  activeView: ViewName
  inputMode: InputMode
  helpVisible: boolean
  selectedTaskId: string | undefined
  selectedFindingId: string | undefined
  selectedEvidenceId: string | undefined
}

export function createTerminalUiState(snapshot: EngagementSnapshot): TerminalUiState {
  return reconcileTerminalUiState({
    activeView: "MISSION",
    inputMode: "dashboard",
    helpVisible: false,
    selectedTaskId: undefined,
    selectedFindingId: undefined,
    selectedEvidenceId: undefined,
  }, snapshot)
}

export function reconcileTerminalUiState(
  state: TerminalUiState,
  snapshot: EngagementSnapshot,
): TerminalUiState {
  const selectedTask = selectExisting(snapshot.tasks, state.selectedTaskId)
    ?? snapshot.tasks.findLast((task) => task.status === "running")
    ?? snapshot.tasks.at(0)
  const selectedFinding = selectExisting(snapshot.findings, state.selectedFindingId)
    ?? snapshot.findings.at(0)
  const selectedEvidence = selectExisting(snapshot.evidence, state.selectedEvidenceId)
    ?? evidenceForFinding(snapshot, selectedFinding).at(0)
    ?? snapshot.evidence.at(0)

  return {
    ...state,
    selectedTaskId: selectedTask?.id,
    selectedFindingId: selectedFinding?.id,
    selectedEvidenceId: selectedEvidence?.id,
  }
}

export function activateView(
  state: TerminalUiState,
  view: ViewName,
  snapshot: EngagementSnapshot,
): TerminalUiState {
  return reconcileTerminalUiState({ ...state, activeView: view, helpVisible: false }, snapshot)
}

export function moveSelection(
  state: TerminalUiState,
  snapshot: EngagementSnapshot,
  delta: -1 | 1,
): TerminalUiState {
  if (state.activeView === "SWARM") {
    return { ...state, selectedTaskId: move(snapshot.tasks, state.selectedTaskId, delta)?.id }
  }
  if (state.activeView === "FINDINGS") {
    return { ...state, selectedFindingId: move(snapshot.findings, state.selectedFindingId, delta)?.id }
  }
  if (state.activeView === "EVIDENCE") {
    return { ...state, selectedEvidenceId: move(snapshot.evidence, state.selectedEvidenceId, delta)?.id }
  }
  return state
}

export function inspectSelection(
  state: TerminalUiState,
  snapshot: EngagementSnapshot,
): TerminalUiState {
  if (state.activeView !== "FINDINGS") return state
  const finding = snapshot.findings.find((item) => item.id === state.selectedFindingId)
  const evidence = evidenceForFinding(snapshot, finding).at(0)
  if (!evidence) return state
  return { ...state, activeView: "EVIDENCE", selectedEvidenceId: evidence.id, helpVisible: false }
}

export function selectedTask(state: TerminalUiState, snapshot: EngagementSnapshot): TaskRecord | undefined {
  return snapshot.tasks.find((task) => task.id === state.selectedTaskId)
}

export function selectedFinding(state: TerminalUiState, snapshot: EngagementSnapshot): Finding | undefined {
  return snapshot.findings.find((finding) => finding.id === state.selectedFindingId)
}

export function selectedEvidence(state: TerminalUiState, snapshot: EngagementSnapshot): EvidenceRef | undefined {
  return snapshot.evidence.find((evidence) => evidence.id === state.selectedEvidenceId)
}

function evidenceForFinding(snapshot: EngagementSnapshot, finding?: Finding): EvidenceRef[] {
  if (!finding) return []
  const ids = new Set(finding.evidenceIds)
  return snapshot.evidence.filter((evidence) => ids.has(evidence.id))
}

function selectExisting<T extends { id: string }>(items: T[], selectedId?: string): T | undefined {
  return selectedId ? items.find((item) => item.id === selectedId) : undefined
}

function move<T extends { id: string }>(items: T[], selectedId: string | undefined, delta: -1 | 1): T | undefined {
  if (!items.length) return undefined
  const current = Math.max(0, items.findIndex((item) => item.id === selectedId))
  const next = Math.min(items.length - 1, Math.max(0, current + delta))
  return items[next]
}
