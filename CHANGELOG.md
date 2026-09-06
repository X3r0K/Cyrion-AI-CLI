# Changelog

All notable changes to Cyrion Community are documented here.

## Unreleased

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
