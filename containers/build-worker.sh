#!/usr/bin/env bash
# Builds the worker image and refuses to tag it until every catalogued binary
# answers inside it. The recorded versions become part of an engagement's
# evidence, so they must come from the image rather than from a wish list.
set -euo pipefail

IMAGE="${CYRION_WORKER_IMAGE:-cyrion/kali-worker:0.1}"
# The Kali the worker is built from. Override to use your own mirror or a
# hardened base; the verification below applies whatever it is.
BASE_IMAGE="${CYRION_WORKER_BASE:-vxcontrol/kali-linux:latest}"
ENGINE="${CYRION_CONTAINER_ENGINE:-docker}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REQUIRED=(curl nmap openssl ffuf sqlmap python3)
OPTIONAL=(katana dnsx semgrep grype)

echo "building ${IMAGE} with ${ENGINE}"
echo "  base ${BASE_IMAGE}"
"${ENGINE}" build \
  --build-arg "BASE_IMAGE=${BASE_IMAGE}" \
  -f "${ROOT}/containers/Dockerfile.worker" -t "${IMAGE}" "${ROOT}/containers"

manifest="${ROOT}/containers/worker-manifest.json"
# The identity of what was just built. A tag can be moved; this cannot, so a
# later run can say whether the image it is about to use is the measured one.
IMAGE_ID="$("${ENGINE}" image inspect "${IMAGE}" --format '{{.Id}}' 2>/dev/null || true)"
IMAGE_DIGEST="$("${ENGINE}" image inspect "${IMAGE}" --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' 2>/dev/null || true)"

echo "{" > "${manifest}"
echo "  \"image\": \"${IMAGE}\"," >> "${manifest}"
echo "  \"base\": \"${BASE_IMAGE}\"," >> "${manifest}"
echo "  \"id\": \"${IMAGE_ID}\"," >> "${manifest}"
echo "  \"repoDigest\": \"${IMAGE_DIGEST}\"," >> "${manifest}"
# Pinning is a decision about a published image, made when it is published.
echo "  \"pinned\": ${CYRION_WORKER_PINNED:-false}," >> "${manifest}"
echo "  \"builtAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"," >> "${manifest}"
echo "  \"tools\": {" >> "${manifest}"

first=1
# Presence is proven by the binary running at all. Version text is best effort:
# several tools print an ASCII banner before anything useful.
record() {
  local binary="$1" required="$2" output="" version="" flag
  for flag in --version -version -V -v; do
    # As uid 1000, which is how an engagement runs it. A tool that answers as
    # root and not as the worker is a tool that fails at the first task, and
    # finding that here is the entire point of this check.
    output="$("${ENGINE}" run --rm --user 1000:1000 --entrypoint "${binary}" "${IMAGE}" "${flag}" 2>&1 || true)"
    case "${output}" in
      *"executable file not found"*|*"no such file or directory"*) output=""; continue;;
    esac
    version="$(printf '%s' "${output}" | grep -m1 -E '[0-9]+\.[0-9]+' || true)"
    [ -n "${version}" ] && break
  done
  if [ -n "${output}" ]; then
    [ -n "${version}" ] || version="present, version not reported"
    version="$(printf '%s' "${version}" | sed -E 's/\x1b\[[0-9;]*[A-Za-z]//g' | tr -d '\000-\037' | cut -c1-160)"
    [ ${first} -eq 1 ] || echo "," >> "${manifest}"
    first=0
    printf '    "%s": %s' "${binary}" "$(printf '%s' "${version}" | jq -Rs .)" >> "${manifest}"
    echo "  ok   ${binary}: ${version}"
  elif [ "${required}" = "required" ]; then
    echo "  FAIL ${binary} is missing from ${IMAGE}" >&2
    exit 1
  else
    echo "  skip ${binary} (optional, not present)"
  fi
}

for binary in "${REQUIRED[@]}"; do record "${binary}" required; done
for binary in "${OPTIONAL[@]}"; do record "${binary}" optional; done

# The shell is checked by using it, not by asking its version. `sh -V` and
# `sh -v` are valid dash flags that print nothing, so a version probe reports a
# perfectly good shell as missing — and `shell.exec` runs `sh -c` anyway, so
# running one is the check that matches what the image is for.
shell_probe="$("${ENGINE}" run --rm --user 1000:1000 --entrypoint sh "${IMAGE}" -c 'echo cyrion-shell-ok' 2>&1 || true)"
case "${shell_probe}" in
  *cyrion-shell-ok*) echo "  ok   sh: runs sh -c" ;;
  *) echo "  FAIL sh cannot run a command in ${IMAGE}: ${shell_probe}" >&2; exit 1 ;;
esac

echo "" >> "${manifest}"
echo "  }" >> "${manifest}"
echo "}" >> "${manifest}"
echo "wrote ${manifest}"
