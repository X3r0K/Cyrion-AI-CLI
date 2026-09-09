import { spawnBounded } from "./process"
import type { ContainerEngine } from "./container"

/** What the release recorded about its worker image, so a run can compare. */
export interface WorkerImagePin {
  image: string
  /** Content identity of the image the release was built and measured with. */
  id?: string
  /** Registry digest, present once the image has been pushed or pulled. */
  repoDigest?: string
  /**
   * Whether that identity is a requirement or a record.
   *
   * A published image can be pinned: everyone pulls the same bytes, so anything
   * else is wrong. An image every operator builds for themselves cannot be —
   * two correct builds of the same Dockerfile differ — so the difference is
   * reported and the run continues.
   */
  pinned?: boolean
}

export interface WorkerImageStatus {
  image: string
  present: boolean
  id?: string
  repoDigest?: string
  createdAt?: string
  /** What an operator needs to read, whether it worked or not. */
  detail: string
}

const INSPECT_FORMAT = "{{.Id}}\t{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}\t{{.Created}}"

/**
 * What the worker image on this machine actually is.
 *
 * A tag is a name someone can move; the identity underneath it is not. Reading
 * it before a run is what turns "the sandbox is ready" from a claim about a
 * string into a statement about the image that will execute the tools — and it
 * is how a missing image becomes a sentence with the build command in it rather
 * than an engine error halfway through an engagement.
 */
export async function inspectWorkerImage(
  engine: ContainerEngine,
  image: string,
): Promise<WorkerImageStatus> {
  const path = Bun.which(engine)
  if (!path) return { image, present: false, detail: `${engine} is not installed` }
  const result = await spawnBounded({
    argv: [path, "image", "inspect", image, "--format", INSPECT_FORMAT],
    cwd: "/",
    env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" },
    timeoutMs: 20_000,
    maxOutputBytes: 8_192,
    runner: "container",
  }).catch(() => undefined)

  if (!result || result.exitCode !== 0) {
    return {
      image,
      present: false,
      detail: `${image} is not present on this machine`,
    }
  }
  const [id = "", repoDigest = "", created = ""] = result.stdout.trim().split("\t")
  return {
    image,
    present: true,
    ...(id ? { id } : {}),
    ...(repoDigest ? { repoDigest } : {}),
    ...(created ? { createdAt: created } : {}),
    detail: `${image} ${short(repoDigest || id)}`,
  }
}

/**
 * Pulls the worker image, so a first run is a run and not an errand.
 *
 * Container is the default sandbox, which makes a missing image the first thing
 * a new operator would otherwise meet — the exact ceremony the rest of this
 * release deletes, moved one step later. Returns what it pulled, or the reason
 * it could not, and never throws: the caller decides whether local is a usable
 * answer on this machine.
 */
export async function pullWorkerImage(
  engine: ContainerEngine,
  image: string,
  timeoutMs = 600_000,
): Promise<{ pulled: boolean; detail: string }> {
  const path = Bun.which(engine)
  if (!path) return { pulled: false, detail: `${engine} is not installed` }
  const result = await spawnBounded({
    argv: [path, "pull", image],
    cwd: "/",
    env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" },
    timeoutMs,
    maxOutputBytes: 65_536,
    runner: "container",
  }).catch(() => undefined)
  if (!result || result.exitCode !== 0) {
    const reason = result?.stderr.trim().split("\n").at(-1)?.slice(0, 200)
    return { pulled: false, detail: reason || `${engine} could not pull ${image}` }
  }
  return { pulled: true, detail: `pulled ${image}` }
}

/**
 * Why this image may not be used, in the operator's language.
 *
 * A missing image still refuses — nothing can run — but by the time this is
 * reached the caller has already tried to pull it, so the remedy named here is
 * the one left: build it, or use local. A *different* image refuses only when
 * the release pinned one, because an image operators build for themselves is
 * different on every machine by construction. Either way the comparison is made
 * only against the image the record names: an operator who passed `--image`
 * asked for something else.
 */
export function workerImageError(
  status: WorkerImageStatus,
  pin: WorkerImagePin | undefined,
): string | undefined {
  if (!status.present) {
    return `The worker image ${status.image} could not be pulled and is not on this machine. Build it with `
      + "./containers/build-worker.sh, or run with --sandbox local."
  }
  const difference = imageDifference(status, pin)
  if (!difference || !pin?.pinned) return undefined
  return `${difference} This release pins that image, so the run is refused: pull the pinned image, or pass `
    + "--image to run a different one deliberately."
}

/**
 * How this machine's image differs from the one the release measured.
 *
 * Not a refusal. A local build legitimately differs, and an operator comparing
 * their numbers with the published ones deserves to know that the tools came
 * from somewhere else — quietly measuring a different image is how two people
 * disagree about a result and never find out why.
 */
export function workerImageDrift(
  status: WorkerImageStatus,
  pin: WorkerImagePin | undefined,
): string | undefined {
  if (!status.present || pin?.pinned) return undefined
  const difference = imageDifference(status, pin)
  return difference
    ? `${difference} That is expected for an image you built yourself; published measurements came from the `
      + "recorded one."
    : undefined
}

function imageDifference(status: WorkerImageStatus, pin: WorkerImagePin | undefined): string | undefined {
  if (!pin || pin.image !== status.image) return undefined
  const recorded = pin.repoDigest ?? pin.id
  const actual = pin.repoDigest ? status.repoDigest : status.id
  if (!recorded || !actual || recorded === actual) return undefined
  return `The worker image ${status.image} on this machine is ${short(actual)}, and this release recorded `
    + `${short(recorded)}.`
}

/** How the image is named in a report and in the terminal. */
export function workerImageLabel(status: WorkerImageStatus): string {
  return status.repoDigest || status.id || (status.present ? status.image : "not present")
}

function short(digest: string): string {
  const value = digest.includes("@") ? digest.slice(digest.indexOf("@") + 1) : digest
  return value.length > 19 ? `${value.slice(0, 19)}…` : value
}
