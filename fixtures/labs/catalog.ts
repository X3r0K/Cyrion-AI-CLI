import type { LabGroundTruth } from "@cyrion/benchmark"
import { startLab } from "../lab/server"
import { startCleanLab, startPartialLab, type LabServer } from "./servers"

/**
 * What each lab contains, written in the same terms a report records: the
 * methodology that should produce a finding, and the asset it belongs to.
 *
 * Ground truth is stated here and nowhere else. A benchmark whose expectations
 * live inside the code being measured cannot fail, so these entries are the
 * only thing the scorer trusts.
 */
export interface LabDefinition {
  truth: (origin: string) => LabGroundTruth
  start(): LabServer
}

export const labs: Record<string, LabDefinition> = {
  imperfect: {
    start: () => startLab(0),
    truth: (origin) => ({
      id: "imperfect",
      name: "Two known issues and two correct endpoints",
      purpose: "Recall, and precision against endpoints that behave correctly.",
      targets: [`${origin}/`, `${origin}/api/objects/42`, `${origin}/api/private/9`, `${origin}/hardened`],
      expected: [
        // The index page sets none of the browser protections.
        { skillId: "web-security-headers", asset: `${origin}/`, severity: "low" },
        // The object endpoint answers a request that carries no credential, and
        // that same response also omits the protections.
        { skillId: "web-security-headers", asset: `${origin}/api/objects/42`, severity: "low" },
        { skillId: "api-object-boundary", asset: `${origin}/api/objects/42`, severity: "high" },
      ],
      confirmable: true,
    }),
  },
  clean: {
    start: () => startCleanLab(0),
    truth: (origin) => ({
      id: "clean",
      name: "Everything correct",
      purpose: "False-positive rate. Anything confirmed here is wrong.",
      targets: [`${origin}/`, `${origin}/api/objects/42`],
      expected: [],
      confirmable: true,
    }),
  },
  partial: {
    start: () => startPartialLab(0),
    truth: (origin) => ({
      id: "partial",
      name: "Answers inconsistently",
      purpose: "Inconclusive-rate honesty. A confirmed finding here is a guess.",
      targets: [`${origin}/`, `${origin}/api/flaky/7`],
      expected: [],
      // Discovery and reproduction never see the same behaviour, so nothing
      // here can honestly reach confirmed.
      confirmable: false,
    }),
  },
}

export const labIds = Object.keys(labs)
