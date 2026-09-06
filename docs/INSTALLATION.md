# Installation

Cyrion Community currently requires Bun 1.3.12 or newer and is tested first on
Linux. macOS uses the same Bun package; Windows support is through WSL2 for the
public alpha.

## Run from source

```bash
git clone https://github.com/X3r0K/Cyrion-AI-CLI.git
cd Cyrion-AI-CLI
bun install --frozen-lockfile
bun run check
bun run demo
```

## Build the distributable CLI

```bash
bun run build
bun dist/cyrion.js version
bun dist/cyrion.js demo --headless --fixture known-positive
```

The bundle keeps its fixture manifests and public agent definitions beside the
installed package. It does not embed credentials, local `.env` files, SQLite
state, or `.cyrion` artifacts.

For local command discovery, build and link the package with Bun:

```bash
bun run build
bun link
cyrion help
```

## Durable run and report

```bash
cyrion demo --headless --fixture known-positive \
  --state .cyrion/community.sqlite \
  --artifacts .cyrion/artifacts

cyrion status ENG-0042 --state .cyrion/community.sqlite
cyrion report ENG-0042 --state .cyrion/community.sqlite --format markdown
```

The report command emits to standard output so operators can explicitly choose
the destination and overwrite behavior with normal shell redirection.

## Supervised fixture run

Interactive runs use `a` and `x` to approve or deny each Root delegation:

```bash
cyrion demo --mode supervised
```

Non-interactive fixture automation must acknowledge automatic approval:

```bash
cyrion demo --headless --mode supervised --approve-all
```
