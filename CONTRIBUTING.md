# Contributing

Thank you for helping improve Cyrion Community. Contributions should preserve a
useful local workflow without copying private Cyrion code, prompts, evaluation
data, or assessment methodology.

## Development

1. Create a focused branch from `main`.
2. Install with `bun install --frozen-lockfile`.
3. Add tests for behavior changes.
4. Run `bun run check` and `bun run release:check`.
5. Open a pull request describing the public contract or operator behavior that
   changed, its safety implications, and how it was tested.

Keep runtime-specific code inside `packages/runtime-opencode`. Models request
typed capabilities; they must not receive unrestricted host shell or network
access. New targets, capabilities, and budgets must remain controller-enforced.

Fixtures must be deterministic, non-destructive, and use reserved or clearly
fictional targets. Do not commit real customer evidence, credentials, tokens,
private reports, or copied commercial implementation details.

Report security vulnerabilities through the private process in `SECURITY.md`,
not through a public issue.
