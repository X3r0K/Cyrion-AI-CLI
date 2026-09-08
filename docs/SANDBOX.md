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

`containers/Dockerfile.worker` builds from `kalilinux/kali-rolling` with the
tools the capability catalog names, an unprivileged `pentester` user, and no
build tooling left behind. `containers/build-worker.sh` builds it, refuses to
finish unless every required binary answers inside the image, and writes
`containers/worker-manifest.json` with the versions — those versions become part
of an engagement's evidence, so they are recorded from the image rather than
assumed.

```sh
CYRION_WORKER_IMAGE=cyrion/kali-worker:0.1 ./containers/build-worker.sh
cyrion probe --capability net.portscan --target 10.10.0.0/24 --sandbox container
```

## Evidence

Every capability writes its raw output — argv included — to the evidence store
before returning a bounded, typed summary. The model sees the summary; the
operator can open the artifact and verify its digest. That is what makes a
finding traceable back to a command rather than to a claim.
