# Security policy

## Supported versions

The latest tagged public-alpha release and the current `main` branch receive
security fixes. Earlier alpha snapshots are unsupported.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting feature for this repository:

1. Open the repository's **Security** tab.
2. Select **Advisories** and **Report a vulnerability**.
3. Include affected version, impact, reproduction steps, and a minimal safe
   proof of concept.

Do not include credentials, customer targets, or sensitive evidence. Please do
not open a public issue until a maintainer has coordinated disclosure. If private
reporting is unavailable, open a non-sensitive issue asking the maintainers to
enable a private contact channel; do not disclose vulnerability details there.

## Scope

Security issues include scope-policy bypasses, credential exposure, unsafe
artifact paths, terminal escape injection, durable-state corruption, and worker
isolation failures. Reports about attacking third-party systems with Cyrion are
not accepted and may be removed.
