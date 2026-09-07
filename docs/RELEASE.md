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
   the npm tarball, CycloneDX 1.6 SBOM, and `SHA256SUMS` to `release/`.
6. From `release/`, run `sha256sum -c SHA256SUMS`, then test the tarball on a
   clean supported Linux environment before signing the
   tag and attaching the tarball, checksum, and SBOM to the GitHub release.

`release:check` builds the CLI, creates a temporary npm tarball, extracts it
outside the source tree, installs it as a dependency of a clean temporary
consumer, runs the known-positive and supervised workflows from the installed
package, reads durable status, and renders a report. Its temporary package,
consumer, state, and artifacts are deleted after the check.

No release result should be described as a live security benchmark. The fixture
version and model/runtime configuration must accompany any published evaluation.
