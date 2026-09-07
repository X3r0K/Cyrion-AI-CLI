# Changelog

All notable changes to Cyrion Community are documented here.

## Unreleased

- Fixed Root-chat keyboard routing so focused text entry always receives letter
  keys; removed the conflicting `h`/`l` navigation aliases in favor of `[`/`]`.
- Added a fifth terminal Settings view for safe provider/model selection and
  persisted mode, fixture, and color defaults without rendering or rewriting
  provider credentials.
- Fixed packaged and globally linked TUI startup by resolving OpenTUI native
  libraries through explicit platform-specific optional dependencies, with a
  packed-consumer TUI smoke check in the release gate.
- Added an interactive connected-provider/model picker and refreshed the
  terminal with translucent blue-black Kali-inspired panels and brighter cyan
  focus states based on the original product references.
- Added a packaged environment template, provider/model validation,
  OpenCode provider readiness diagnostics, and visible runtime configuration in
  the terminal without enabling unscoped live assessment.
- Added a repeatable release-artifact command that emits the npm tarball, a
  CycloneDX 1.6 production-dependency SBOM, and SHA-256 checksums after testing
  the installed package from a clean temporary consumer.
- Made the controller own the engagement evidence store and require canonical
  metadata plus SHA-256 verification before accepting worker evidence.
- Added recovery-time evidence revalidation and adversarial tests for missing,
  forged, and post-capture-tampered artifacts.
- Implemented durable supervised delegation with interactive approve/deny
  controls, explicit headless opt-in, audit events, and restart revalidation.
- Added strict runtime parsing for manifests, Root decisions, worker results,
  evidence metadata, findings, and provider usage.
- Bound worker output to task targets and agent provenance, enforced fresh
  independent validation, and rejected cyclic task graphs.
- Added bounded `task.result.rejected` audit events and adversarial output tests.
- Run fixture capabilities in short-lived subprocesses with a scrubbed
  environment, private work directory, bounded streams, and abort-driven
  termination.
- Added explicit hardening tests and documentation for the remaining
  container/egress boundary.

## 0.1.0-alpha.1 — 2026-09-06

- Added the durable Root controller, task leases, budgets, event persistence,
  restart reconciliation, and scope-bound tool gateway.
- Added deterministic confirmed, clean, rejected, and incomplete fixtures.
- Added local evidence storage with SHA-256 verification and safe metadata.
- Added the four-view interactive product terminal with worker and evidence
  inspection, Root chat, pause/resume, responsive layouts, and `NO_COLOR`.
- Added versioned Markdown/JSON report exports, durable status commands, release
  packaging checks, and public contribution/security documentation.

This alpha contains fixture workers only. It does not ship a live network
assessment adapter or claim parity with the commercial Cyrion platform.
