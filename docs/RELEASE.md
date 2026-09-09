# Release process

The public alpha is released from a clean `main` checkout. Publishing a package
is a maintainer action and is not performed by CI.

1. Confirm the CLI and fixture versions in `package.json`, `apps/cli/src/index.ts`,
   `CHANGELOG.md`, and `fixtures/manifest.json`.
2. Run `bun install --frozen-lockfile`.
3. Run `bun run release:check`.
4. Inspect `npm pack --dry-run` and confirm that `.env`, `.cyrion`, SQLite,
   coverage, logs, reference images, and repository history are absent.
5. Run `bun run release:artifacts`. This repeats the release check and writes
   the npm tarball, CycloneDX 1.6 SBOM, the worker image record
   (`worker-manifest.json`: the image, its identity, and the tool versions
   measured inside it), and `SHA256SUMS` to `release/`.
6. Run `bun run bench` and commit the regenerated `BENCHMARKS.md`. The numbers
   ship with the release, so they must come from the code being released.
7. From `release/`, run `sha256sum -c SHA256SUMS`, then test the tarball on a
   clean supported Linux environment before signing the
   tag and attaching the tarball, checksum, and SBOM to the GitHub release.
8. On that clean environment, run `bun run bench` from a fresh clone and confirm
   the table matches the published one. A difference is a regression to explain,
   not noise to accept.

`release:check` builds the CLI, creates a temporary npm tarball, extracts it
outside the source tree, installs it as a dependency of a clean temporary
consumer, runs the known-positive and supervised workflows from the installed
package, reads durable status, and renders a report. Its temporary package,
consumer, state, and artifacts are deleted after the check.

No release result should be described as a live security benchmark. `BENCHMARKS.md`
carries its own Cyrion version, fixture version, planner, worker, and sandbox,
and states plainly that its recall is measured against what the labs contain
rather than being a claim about finding unknown classes of issue. Any published
evaluation must keep that framing, and must say when a model was in the loop —
those numbers are a sample, not a fact.
