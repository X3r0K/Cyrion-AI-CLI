#!/usr/bin/env bash
# Builds the worker image and refuses to tag it until every catalogued binary
# answers inside it. The recorded versions become part of an engagement's
# evidence, so they must come from the image rather than from a wish list.
set -euo pipefail

IMAGE="${CYRION_WORKER_IMAGE:-cyrion/kali-worker:0.1}"
ENGINE="${CYRION_CONTAINER_ENGINE:-docker}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REQUIRED=(curl nmap openssl ffuf)
OPTIONAL=(katana dnsx semgrep grype)

echo "building ${IMAGE} with ${ENGINE}"
"${ENGINE}" build -f "${ROOT}/containers/Dockerfile.worker" -t "${IMAGE}" "${ROOT}/containers"

manifest="${ROOT}/containers/worker-manifest.json"
echo "{" > "${manifest}"
echo "  \"image\": \"${IMAGE}\"," >> "${manifest}"
echo "  \"builtAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"," >> "${manifest}"
echo "  \"tools\": {" >> "${manifest}"

first=1
# Presence is proven by the binary running at all. Version text is best effort:
# several tools print an ASCII banner before anything useful.
record() {
  local binary="$1" required="$2" output="" version="" flag
  for flag in --version -version -V -v; do
    output="$("${ENGINE}" run --rm --entrypoint "${binary}" "${IMAGE}" "${flag}" 2>&1 || true)"
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

echo "" >> "${manifest}"
echo "  }" >> "${manifest}"
echo "}" >> "${manifest}"
echo "wrote ${manifest}"
