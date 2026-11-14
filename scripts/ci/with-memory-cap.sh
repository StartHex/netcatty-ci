#!/usr/bin/env bash
# Runs a command under a hard memory ceiling when the machine can provide one,
# and runs it as is when it cannot.
#
#   scripts/ci/with-memory-cap.sh npm test
#   MEMORY_CAP=6G scripts/ci/with-memory-cap.sh node --test ...
#   MEMORY_CAP=off ...            # never cap
#
# Why: a failing assert.equal() on a DOM node makes Node print a diff of the
# node, and a mounted node drags the whole React tree and the jsdom window
# along with it. The process then allocates gigabytes within seconds. On a
# hosted CI runner that ends with "The runner has received a shutdown signal"
# and a log that stops mid-run, without a word about which test failed.
#
# Inside a capped scope the kernel stops only the process that ran away. The
# test runner reports that file as failed (killed) and carries on with the
# rest, so the run still tells what went wrong.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: with-memory-cap.sh <command> [args...]" >&2
  exit 64
fi

limit="${MEMORY_CAP:-8G}"

oom_kills() {
  awk '$1 == "oom_kill" { print $2; found = 1 } END { if (!found) print 0 }' /proc/vmstat 2>/dev/null || echo 0
}

# sudo only starts the scope. The command itself runs as the calling user with
# that user's groups, in the calling directory, with exactly the calling
# environment: sudo resets the environment (and not every sudo honours -E), so
# it is handed over through a private file and restored into an empty one.
environment_file="$(mktemp)"
trap 'rm -f "${environment_file}"' EXIT
export -p > "${environment_file}"

bash_path="$(command -v bash)"
env_path="$(command -v env)"
setpriv_path="$(command -v setpriv || true)"

run_capped() {
  sudo -n systemd-run --quiet --scope --collect \
    -p "MemoryMax=${limit}" -p MemorySwapMax=0 -p OOMPolicy=continue \
    -- "${setpriv_path}" --reuid="$(id -u)" --regid="$(id -g)" --init-groups \
    "${env_path}" -i "${bash_path}" -c 'source "$1"; shift; exec "$@"' \
    with-memory-cap "${environment_file}" "$@"
}

can_cap() {
  [ "${limit}" != "off" ] || return 1
  [ -n "${setpriv_path}" ] || return 1
  command -v systemd-run >/dev/null 2>&1 || return 1
  command -v sudo >/dev/null 2>&1 || return 1
  run_capped true >/dev/null 2>&1
}

if ! can_cap; then
  if [ "${limit}" != "off" ]; then
    echo "with-memory-cap: no capped scope available here, running without a memory cap" >&2
  fi
  rm -f "${environment_file}"
  trap - EXIT
  exec "$@"
fi

kills_before="$(oom_kills)"
status=0
run_capped "$@" || status=$?
kills_after="$(oom_kills)"

if [ "${kills_after}" -gt "${kills_before}" ]; then
  message="A process hit the ${limit} memory cap and was stopped. Look for the test file reported as killed (SIGKILL); a failed assert.equal() on a DOM node is the usual cause - compare with === and assert the boolean instead."
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    echo "::error title=Memory cap reached::${message}"
  else
    echo "with-memory-cap: ${message}" >&2
  fi
  # A killed process must not pass for a green run, whatever the command made of it.
  if [ "${status}" -eq 0 ]; then
    status=137
  fi
fi

exit "${status}"
