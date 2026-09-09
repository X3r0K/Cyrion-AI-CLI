# Where capabilities run

A capability is a typed request — never a shell string — and Cyrion decides how
to execute it. There are two execution modes, and the right one depends on the
machine you are working from.

```sh
cyrion tools                       # what this machine can already do
cyrion tools --sandbox local       # what local mode would enforce here
cyrion probe --capability http.probe --target https://app.lab.test --manifest engagement.json
```

`cyrion tools` picks a default for you: **local** on a security distribution
(Kali, Parrot, BlackArch, BackBox, Pentoo, Athena) or when no container engine
is installed, **container** otherwise. `--sandbox` overrides it anywhere.

## Local mode — your machine, your toolchain

This is the mode most Kali and Parrot users want. The tools are already
installed, already the versions you trust, and already configured. Cyrion runs
them directly:

```sh
cyrion probe --capability net.portscan --target 10.10.0.0/24 --sandbox local
cyrion demo --sandbox local
```

What still applies, because none of it needs a kernel boundary:

- the capability allowlist — a binary outside it is refused before it is looked up
- argv assembled by the adapter from a validated target, never by a model
- a scrubbed environment: no operator credentials, no inherited settings
- a private working directory, removed after every run
- an output ceiling and a wall-clock timeout
- the whole process group terminated on timeout or cancellation

What it cannot give you, stated plainly because assuming otherwise is the
dangerous part:

- filesystem isolation from the host
- a kernel-enforced egress allowlist
- protection from a tool that misbehaves while running with your privileges

Scope is still enforced — at the target the adapter is allowed to name and at
the addresses it pinned — but nothing stops a tool that decides to contact
something else. On a machine you own, running tools you chose, that is usually
the trade you want. Say so deliberately rather than by accident.

## Installing the toolchain

`cyrion tools` lists every capability, the binary behind it, whether it is
installed, and its version. Several capabilities are implemented inside Cyrion
and need nothing installed at all, so local mode is useful on a bare machine
before you install a single package.

For what is missing, Cyrion prints the exact command for your package manager
(apt, dnf, pacman, zypper, apk, or brew) and the upstream instructions for tools
that are not packaged:

```
install what is missing
  sudo apt-get install -y ffuf nmap semgrep
  katana: go install github.com/projectdiscovery/katana/cmd/katana@latest
```

**Cyrion never installs packages for you.** It prints the command; you decide.
`cyrion tools --check` exits non-zero when a required tool is missing, which is
what you want in a pipeline.

On Kali most of this is already present — `cyrion tools` will usually show a
clean list and you can go straight to work.

## Container mode — isolation by construction

The dedicated bridge is created on first use, and a container left behind by a
run that died is removed before a new one starts, so neither is something you
have to set up by hand.

**Every capability leaves from inside the container.** `http.probe` is
implemented in the Cyrion process for local mode — that is what makes it work on
a machine with nothing installed — and falls back to `curl` inside the sandbox
when the runner is a container. Otherwise the egress allowlist installed into
that namespace would govern nothing that matters, since the capability an
engagement uses most would never enter it. Pinned addresses reach curl as one
`--resolve` entry so it can fall back across address families, with IPv6
bracketed.

**A container's loopback is its own.** A lab on this machine's `127.0.0.1` is
not there at all, and Cyrion says so before the run starts rather than letting
you meet it as a connection refused halfway through. Use `--sandbox local` for a
target on this machine, or put the target on the `cyrion-sandbox` network.

Repository targets are read from this machine's filesystem, which a container
with no host mounts cannot see; use local mode for those.

One long-lived container per engagement, executed into per capability:

| Control | Setting |
| --- | --- |
| User | `--user 1000:1000`, with the work tmpfs owned by that user |
| Filesystem | Read-only root, tmpfs `/work` and `/tmp`, no host mounts, no engine socket |
| Capabilities | `--cap-drop ALL`, `--security-opt no-new-privileges` |
| Resources | Memory, CPU, and pid ceilings |
| Network | A dedicated bridge, never host networking |
| Egress | Default-DROP allowlist installed into this container's network namespace |

The egress allowlist is the part worth understanding. Cyrion does not touch your
host firewall. It enters the container's own network namespace from the host
(`nsenter -t <pid> -n iptables …`) and installs: drop by default, allow
loopback, allow established, allow DNS to the pinned resolver, then allow
exactly the addresses and ports the engagement pinned. The container has no
`NET_ADMIN` and no `iptables`, so a process inside cannot remove it.

The allowlist is derived from the approved scope *before* the container starts:
literal addresses and ranges as written, hostnames resolved once and pinned so
the firewall and every later connection agree on the same answer. Exclusions
become DROP rules ahead of every accept, so a host excluded from an approved
range is refused by the kernel too, not only by the scope check. A wildcard
entry names hosts that do not exist yet and is reported as unpinnable rather
than quietly widened.

**Requirements:** a container engine, `nsenter`, and root on the host. Without
them the allowlist cannot be installed, and Cyrion refuses to start rather than
running unfiltered — it prints the rules it would have installed so you can see
exactly what is missing. Accept the risk explicitly if you must.

## The worker image

`containers/Dockerfile.worker` builds from `vxcontrol/kali-linux` with the tools
the capability catalog names, an unprivileged uid 1000 owning `/work`, and no
build tooling left behind. `containers/build-worker.sh` builds it, refuses to
finish unless every required binary answers inside the image, and writes
`containers/worker-manifest.json` with the versions — those versions become part
of an engagement's evidence, so they are recorded from the image rather than
assumed.

The shell is checked by running `sh -c`, not by asking its version: `sh -V` and
`sh -v` are valid flags that print nothing, so a version probe reports a working
shell as missing. Running one is also the check that matches what the image is
for, since `shell.exec` runs `sh -c`.

```sh
./containers/build-worker.sh
CYRION_WORKER_IMAGE=cyrion/kali-worker:0.1 ./containers/build-worker.sh
cyrion probe --capability net.portscan --target 10.10.0.0/24 --sandbox container
```

The base is a variable. Point it at your own mirror, a hardened build, or a
different Kali distribution — the verification applies whatever it is, so a base
missing something fails the build rather than producing a worker that cannot do
what the catalog promises. The manifest records which base produced the image,
because two images sharing a tag but not a base are not the same evidence.

```sh
CYRION_WORKER_BASE=kalilinux/kali-rolling:latest ./containers/build-worker.sh
```

### Which image actually ran

A tag is a name someone can move; the identity underneath it is not. The build
script records both — the image ID and, when the image came from a registry, its
digest — and Cyrion reads the identity of the image it is about to use:

```sh
cyrion tools --sandbox container
#   sandbox      CONTAINER  READY
#                docker 29.4.0. Worker image cyrion/kali-worker@sha256:50a07537…
```

- **No image** is refused before the engagement starts, with the command that
  fixes it. It used to be an engine error at the first request, after the
  operator had already authorized the run.
- **A different image** is reported, not refused: two correct builds of the same
  Dockerfile differ, so a rebuild is normal. What is not normal is measuring one
  image and comparing the numbers with another's, so Cyrion says which one it
  found and which one the release recorded.
- **A pinned image** — `"pinned": true` in the manifest, set when an image is
  published so everyone pulls the same bytes — is a requirement, and anything
  else is refused. `--image` says plainly that you meant a different one, and is
  never second-guessed.

The image identity is recorded in the report beside the tool versions, because
`nmap 7.99` from one image is not the same claim as `nmap 7.99` from another.

## Evidence

Every capability writes its raw output — argv included — to the evidence store
before returning a bounded, typed summary. The model sees the summary; the
operator can open the artifact and verify its digest. That is what makes a
finding traceable back to a command rather than to a claim.
