#!/usr/bin/env bash
# Run cursor-agent on a loop with a fixed prompt.
#
# Usage:
#   ./scripts/agent-loop.sh 60 "fix the next failing test"
#   ./scripts/agent-loop.sh 5m "improve error handling in packages/station"
#   ./scripts/agent-loop.sh --interval 120 --prompt-file ./prompt.txt
#   MAX_ITERATIONS=10 ./scripts/agent-loop.sh 30s "keep going"
#   MODEL=sonnet-4 ./scripts/agent-loop.sh 1m "refactor station.js"
#
# Environment:
#   CURSOR_AGENT   CLI binary (default: cursor-agent)
#   INTERVAL       Seconds between runs (overridden by first arg if present)
#   MAX_ITERATIONS 0 = infinite until Ctrl+C (default: 0)
#   MODEL          Optional model flag passed to cursor-agent
#   WORKSPACE      Working directory for the agent (default: repo root)
#   LOG_DIR        Where iteration logs are written
#   CONTINUE       1 = pass --continue after the first iteration (default: 1)
#   PROMPT         Default prompt if none is passed on the CLI
#
# Requires: cursor-agent on PATH (cursor-agent login)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

CURSOR_AGENT="${CURSOR_AGENT:-cursor-agent}"
INTERVAL="${INTERVAL:-60}"
MAX_ITERATIONS="${MAX_ITERATIONS:-0}"
MODEL="${MODEL:-}"
WORKSPACE="${WORKSPACE:-${REPO_ROOT}}"
LOG_DIR="${LOG_DIR:-${REPO_ROOT}/.agent-loop/logs}"
CONTINUE="${CONTINUE:-1}"
PROMPT="${PROMPT:-}"

usage() {
  cat <<'EOF'
Usage:
  agent-loop.sh <interval> <prompt>
  agent-loop.sh --interval <interval> --prompt <text>
  agent-loop.sh --interval <interval> --prompt-file <path>

Interval examples: 30s, 5m, 2h, 90 (seconds)

Options:
  -i, --interval <value>     Delay between runs (default: 60s or $INTERVAL)
  -p, --prompt <text>        Prompt text for each iteration
  -f, --prompt-file <path>   Read prompt from a file
  -w, --workspace <path>     Agent workspace (default: repo root)
  -n, --max-iterations <n>   Stop after n runs (default: infinite)
  -m, --model <name>         Model passed to cursor-agent
      --no-continue          Start a fresh session every iteration
  -h, --help                 Show this help

Environment overrides: CURSOR_AGENT, INTERVAL, MAX_ITERATIONS, MODEL,
WORKSPACE, LOG_DIR, CONTINUE, PROMPT
EOF
}

looks_like_interval() {
  [[ "$1" =~ ^[0-9]+(s|m|h|d)?$ ]]
}

parse_duration() {
  local raw="$1"
  if [[ "${raw}" =~ ^[0-9]+$ ]]; then
    echo "${raw}"
    return
  fi
  if [[ "${raw}" =~ ^([0-9]+)(s|m|h|d)$ ]]; then
    local amount="${BASH_REMATCH[1]}"
    local unit="${BASH_REMATCH[2]}"
    case "${unit}" in
      s) echo "${amount}" ;;
      m) echo $((amount * 60)) ;;
      h) echo $((amount * 3600)) ;;
      d) echo $((amount * 86400)) ;;
    esac
    return
  fi
  echo "error: invalid interval '${raw}' (use 30s, 5m, 2h, or plain seconds)" >&2
  exit 1
}

PROMPT_FILE=""
POSITIONAL=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -i|--interval)
      INTERVAL="$2"
      shift 2
      ;;
    -p|--prompt)
      PROMPT="$2"
      shift 2
      ;;
    -f|--prompt-file)
      PROMPT_FILE="$2"
      shift 2
      ;;
    -w|--workspace)
      WORKSPACE="$2"
      shift 2
      ;;
    -n|--max-iterations)
      MAX_ITERATIONS="$2"
      shift 2
      ;;
    -m|--model)
      MODEL="$2"
      shift 2
      ;;
    --no-continue)
      CONTINUE=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      POSITIONAL+=("$@")
      break
      ;;
    -*)
      echo "error: unknown option '$1'" >&2
      usage >&2
      exit 1
      ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done

if [[ ${#POSITIONAL[@]} -ge 1 && -z "${PROMPT}" && -z "${PROMPT_FILE}" ]]; then
  if looks_like_interval "${POSITIONAL[0]}" && [[ ${#POSITIONAL[@]} -ge 2 ]]; then
    INTERVAL="${POSITIONAL[0]}"
    PROMPT="${POSITIONAL[1]}"
    if [[ ${#POSITIONAL[@]} -gt 2 ]]; then
      PROMPT+=" ${POSITIONAL[*]:2}"
    fi
  else
    PROMPT="${POSITIONAL[*]}"
  fi
fi

if [[ -n "${PROMPT_FILE}" ]]; then
  if [[ ! -f "${PROMPT_FILE}" ]]; then
    echo "error: prompt file not found: ${PROMPT_FILE}" >&2
    exit 1
  fi
  PROMPT="$(cat "${PROMPT_FILE}")"
fi

if [[ -z "${PROMPT}" ]]; then
  echo "error: prompt is required" >&2
  usage >&2
  exit 1
fi

INTERVAL_SECONDS="$(parse_duration "${INTERVAL}")"
mkdir -p "${LOG_DIR}"

if ! command -v "${CURSOR_AGENT}" >/dev/null 2>&1; then
  echo "error: ${CURSOR_AGENT} not found on PATH" >&2
  echo "Install: https://cursor.com/docs/cli" >&2
  exit 1
fi

if ! "${CURSOR_AGENT}" status >/dev/null 2>&1; then
  echo "error: ${CURSOR_AGENT} is not authenticated — run: ${CURSOR_AGENT} login" >&2
  exit 1
fi

stop_requested=0
trap 'stop_requested=1; echo; echo "Stopping after current iteration…"' INT TERM

run_iteration() {
  local iteration="$1"
  local log_file="${LOG_DIR}/iteration-$(printf '%04d' "${iteration}").log"
  local started_at exit_code
  started_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  echo "────────────────────────────────────────────────────────"
  echo "Iteration ${iteration} — ${started_at}"
  echo "Log: ${log_file}"
  echo "────────────────────────────────────────────────────────"

  local -a agent_args=(
    --print
    --trust
    --force
    --approve-mcps
    --workspace "${WORKSPACE}"
    --output-format text
  )

  if [[ -n "${MODEL}" ]]; then
    agent_args+=(--model "${MODEL}")
  fi

  if [[ "${CONTINUE}" == "1" && "${iteration}" -gt 1 ]]; then
    agent_args+=(--continue)
  fi

  {
    echo "=== iteration ${iteration} started ${started_at} ==="
    echo "=== prompt ==="
    echo "${PROMPT}"
    echo "=== agent output ==="
    "${CURSOR_AGENT}" "${agent_args[@]}" "${PROMPT}"
  } 2>&1 | tee "${log_file}"

  exit_code="${PIPESTATUS[0]}"
  if (( exit_code != 0 )); then
    echo "warning: iteration ${iteration} exited ${exit_code}" >&2
  fi
}

echo "cursor-agent loop"
echo "  workspace:   ${WORKSPACE}"
echo "  agent:       ${CURSOR_AGENT}"
echo "  interval:    ${INTERVAL_SECONDS}s"
echo "  max runs:    $([[ "${MAX_ITERATIONS}" == "0" ]] && echo "∞ (Ctrl+C to stop)" || echo "${MAX_ITERATIONS}")"
echo "  continue:    $([[ "${CONTINUE}" == "1" ]] && echo "yes (after first run)" || echo "no")"
echo "  logs:        ${LOG_DIR}"
echo "  prompt:      ${PROMPT//$'\n'/ }"
echo

iteration=1
while [[ "${stop_requested}" -eq 0 ]]; do
  run_iteration "${iteration}" || true

  if [[ "${MAX_ITERATIONS}" != "0" && "${iteration}" -ge "${MAX_ITERATIONS}" ]]; then
    echo "Reached MAX_ITERATIONS=${MAX_ITERATIONS}. Done."
    break
  fi

  if [[ "${stop_requested}" -ne 0 ]]; then
    break
  fi

  echo "Sleeping ${INTERVAL_SECONDS}s before next iteration… (Ctrl+C to stop)"
  sleep "${INTERVAL_SECONDS}" &
  wait $! 2>/dev/null || true

  iteration=$((iteration + 1))
done

echo "Loop stopped after ${iteration} iteration(s)."
