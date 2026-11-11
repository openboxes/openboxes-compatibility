#!/usr/bin/env bash
# Boot one OpenBoxes stack from a published image and record deployment facts.
#
#   stack.sh up   <label> <image>   pull, boot, wait for the login page, write facts
#   stack.sh down <label>           stop the stack and delete its volumes
#   stack.sh check <label>          confirm the app still answers (run right before
#                                   the tests); on failure, deploy.ready becomes a failure
#   stack.sh logs <label>           follow the app log
#
# <image> is a tag or digest reference, e.g. ghcr.io/openboxes/openboxes:v0.9.9
# or ghcr.io/openboxes/openboxes@sha256:... . The image is always recorded by
# digest.
#
# `up` starts from an empty results/<label>/ directory, writes deploy.json,
# app.log and compose.log there, and prints one line per check:
# PASS|FAIL|SKIP|INCONCLUSIVE <check-id> <value>, or INFO <fact-id> <value>
# for recorded facts. When `up` fails, the stack is removed again (logs are
# kept) unless OB_KEEP_STACK=1.
#
# Failure classes: a pull, database, mail, port or Compose problem is
# infra/harness (the verdict becomes INCONCLUSIVE); the app container failing
# to start, exiting, not answering in time, or dying within the stability
# window after its first answer is a readiness failure of the target. When the
# app fails while the database or mail service is down, the failure is infra.
#
# Environment (all optional):
#   OB_HTTP_PORT                host port for the app (default 8080)
#   OB_MAILPIT_PORT             host port for the Mailpit UI (default 8025)
#   OB_BOOT_TIMEOUT_MIGRATIONS  readiness timeout in seconds for a fresh install (default 600)
#   OB_RESULTS_DIR              results root (default ./results)
#   OB_STABILITY_SECONDS        how long the app must keep answering after readiness (default 15)
#   OB_DB_IMAGE                 database image (default mariadb:10.3.39)
#   OB_KEEP_STACK               set to 1 to keep a failed stack for debugging
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
compose_file="$root/compose/docker-compose.yml"

cmd=${1:-}
label=${2:-}
if [[ -z "$cmd" || -z "$label" ]]; then
  sed -n '2,8p' "$0" >&2
  exit 2
fi
# No underscores in labels, so mapping "." to "_" gives every label its own
# Compose project.
if [[ ! "$label" =~ ^[a-z0-9][a-z0-9.-]*$ ]]; then
  echo "label must match [a-z0-9][a-z0-9.-]*: $label" >&2
  exit 2
fi

export COMPOSE_PROJECT_NAME="compat-${label//./_}"
export OB_HTTP_PORT=${OB_HTTP_PORT:-8080}
export OB_MAILPIT_PORT=${OB_MAILPIT_PORT:-8025}
boot_timeout=${OB_BOOT_TIMEOUT_MIGRATIONS:-600}
stability_seconds=${OB_STABILITY_SECONDS:-15}
results="${OB_RESULTS_DIR:-$root/results}/$label"
base_url="http://localhost:${OB_HTTP_PORT}/openboxes"

# Flags appended to the image's own JAVA_TOOL_OPTIONS, never replacing them.
suite_java_flags="-Dgrails.mail.enabled=true -Dgrails.mail.host=mailpit -Dgrails.mail.port=1025"

compose() {
  # Down and logs do not need the image variables; give them placeholders.
  OB_IMAGE=${OB_IMAGE:-unused} OB_JAVA_TOOL_OPTIONS=${OB_JAVA_TOOL_OPTIONS:-unused} \
    docker compose -f "$compose_file" "$@"
}

checks='[]'
# add_check <id> <kind: assertion|fact> <status: pass|fail|skip> <value> [detail] [class]
add_check() {
  local id=$1 kind=$2 status=$3 value=$4 detail=${5:-} class=${6:-}
  checks=$(jq -c --arg id "$id" --arg kind "$kind" --arg status "$status" \
    --arg value "$value" --arg detail "$detail" --arg class "$class" \
    '. + [{id: $id, kind: $kind, status: $status, value: $value}
      + (if $detail == "" then {} else {detail: $detail} end)
      + (if $class == "" then {} else {class: $class} end)]' <<<"$checks")
  local word
  case "$status" in
    pass) word=PASS ;;
    fail) [[ -n "$class" && "$class" != candidate-defect ]] && word=INCONCLUSIVE || word=FAIL ;;
    *) word=SKIP ;;
  esac
  [[ "$kind" == fact ]] && word=INFO
  echo "$word $id $value"
}

port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

# Prints why the supporting services are unusable, or nothing when the
# database is healthy and Mailpit is running.
support_problem() {
  local service id state
  for service in db mailpit; do
    id=$(compose ps --all --quiet "$service" 2>/dev/null || true)
    if [[ -z "$id" ]]; then
      echo "$service container missing"
      return
    fi
    state=$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' \
      "$id" 2>/dev/null || echo "unknown")
    if [[ "$state" != running* || "$state" == *unhealthy* ]]; then
      echo "$service is $state"
      return
    fi
  done
}

# Is the app container running and answering on the login page?
app_answers() {
  local id
  id=$(compose ps --quiet app 2>/dev/null || true)
  [[ -n "$id" && "$(docker inspect --format '{{.State.Status}}' "$id" 2>/dev/null)" == running ]] &&
    [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$base_url/auth/login" || true)" == 200 ]]
}

# On a failed `up`: keep the logs, remove the stack unless asked to keep it.
on_exit() {
  local status=$?
  if ((status != 0)) && [[ "${stack_started:-}" == true ]]; then
    # Keep the log that was scanned, if there is one.
    [[ -s "$results/app.log" ]] ||
      compose logs --no-color --no-log-prefix app >"$results/app.log" 2>&1 || true
    if [[ "${OB_KEEP_STACK:-}" != 1 ]]; then
      compose down --volumes --remove-orphans >/dev/null 2>&1 || true
    fi
  fi
}

write_results() {
  mkdir -p "$results"
  jq -n --arg label "$label" --arg image "$image" --arg digest "${digest:-}" \
    --argjson checks "$checks" \
    '{label: $label, layer: "deploy", target: {image: $image, digest: $digest}, checks: $checks}' \
    >"$results/deploy.json"
}

up() {
  image=${1:?usage: stack.sh up <label> <image>}
  # Never let a previous run's files stand in for this one.
  rm -rf "$results"
  mkdir -p "$results"
  trap on_exit EXIT

  if ! docker pull --quiet --platform linux/amd64 "$image" >/dev/null; then
    add_check deploy.image assertion fail "$image" "docker pull failed" infra
    write_results
    exit 1
  fi
  # Repository part of the reference: drop the digest, then a tag (a ":"
  # after the last "/", so a registry port is kept).
  local repo=${image%@*}
  [[ "${repo##*/}" == *:* ]] && repo=${repo%:*}
  digest=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image" |
    grep -m1 "^${repo}@" || true)
  add_check deploy.image_digest fact pass "${digest:-unknown}"

  local image_opts
  image_opts=$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$image" |
    sed -n 's/^JAVA_TOOL_OPTIONS=//p')
  export OB_IMAGE="${digest:-$image}"
  export OB_JAVA_TOOL_OPTIONS="${image_opts:+$image_opts }$suite_java_flags"

  # A leftover stack under the same label would reuse its database.
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  local port
  for port in "$OB_HTTP_PORT" "$OB_MAILPIT_PORT"; do
    if port_in_use "$port"; then
      add_check deploy.stack assertion fail "port $port" \
        "host port $port is in use; set OB_HTTP_PORT / OB_MAILPIT_PORT" harness
      write_results
      exit 1
    fi
  done

  stack_started=true
  # Supporting services: a failure here says nothing about the target.
  if ! compose up --detach --quiet-pull --wait db mailpit >"$results/compose.log" 2>&1; then
    cat "$results/compose.log" >&2
    add_check deploy.stack assertion fail false "database or mail service did not start" infra
    write_results
    exit 1
  fi

  # The target must start, answer the login page within the boot budget, and
  # keep answering for the stability window. Each failure is first checked
  # against the supporting services and Compose itself.
  local seconds ready=true app_id="" failure="" class="" problem
  if compose up --detach app >>"$results/compose.log" 2>&1; then
    app_id=$(compose ps --all --quiet app)
  else
    cat "$results/compose.log" >&2
    app_id=$(compose ps --all --quiet app 2>/dev/null || true)
    if grep -qiE 'port is already allocated|address already in use|bind for' "$results/compose.log"; then
      failure="app port could not be bound" class=harness
    elif [[ -z "$app_id" ]]; then
      failure="docker compose could not create the app container" class=harness
    else
      # A container that never started, or that the runtime could not start,
      # points at the host, not the target.
      local started runtime_error
      started=$(docker inspect --format '{{.State.StartedAt}}' "$app_id" 2>/dev/null || echo "")
      runtime_error=$(docker inspect --format '{{.State.Error}}' "$app_id" 2>/dev/null || echo "inspect failed")
      if [[ -n "$runtime_error" ]]; then
        failure="app container could not be started: ${runtime_error:0:200}" class=harness
      elif [[ -z "$started" || "$started" == 0001-01-01T00:00:00Z ]]; then
        failure="app container was created but never started" class=harness
      else
        failure="app container did not start: $(tail -1 "$results/compose.log" | cut -c1-200)"
      fi
    fi
    app_id=""
  fi
  if [[ -z "$failure" && -z "$app_id" ]]; then
    failure="docker compose created no app container" class=harness
  fi
  if [[ -z "$failure" ]]; then
    if seconds=$("$here/wait-ready.sh" "$base_url/auth/login" "$boot_timeout" "$app_id" 2>&1); then
      local waited=0
      while ((waited < stability_seconds)); do
        sleep 5
        waited=$((waited + 5))
        if ! app_answers; then
          failure="app stopped answering ${waited}s after readiness"
          break
        fi
      done
    else
      failure=$seconds
    fi
  fi
  if [[ -n "$failure" && -z "$class" ]]; then
    problem=$(support_problem)
    [[ -n "$problem" ]] && failure="$failure ($problem)" class=infra
  fi
  if [[ -z "$failure" ]]; then
    add_check deploy.ready assertion pass true "login page answered 200 after ${seconds}s"
    add_check deploy.ready_seconds fact pass "$seconds"
  else
    ready=false
    add_check deploy.ready assertion fail false "$failure" "$class"
  fi
  compose logs --no-color --no-log-prefix app >"$results/app.log" 2>&1 || true

  # Java: the major version is compared, the full build string is only recorded.
  local java_version java_major
  java_version=$(compose exec -T app java -version 2>&1 | grep -v '^Picked up' | paste -sd ';' - || true)
  java_major=$(sed -nE 's/.*version "(1\.)?([0-9]+).*/\2/p' <<<"$java_version" | head -1)
  if [[ -n "$java_major" ]]; then
    add_check deploy.java_major assertion pass "$java_major"
    add_check deploy.java_version fact pass "$java_version"
  elif [[ "$ready" == true ]]; then
    add_check deploy.java_major assertion fail "" "java -version gave no version"
  else
    add_check deploy.java_major assertion skip "" "app not ready"
  fi

  local effective_opts
  # shellcheck disable=SC2016 # expanded inside the container
  effective_opts=$(compose exec -T app sh -c 'printf %s "$JAVA_TOOL_OPTIONS"' 2>/dev/null || true)
  add_check deploy.java_tool_options fact pass "$effective_opts"

  if [[ "$ready" == true ]]; then
    local path found=""
    for path in /health /actuator/health; do
      if curl -sf --max-time 10 "$base_url$path" | grep -q '"UP"'; then
        found=$path
        break
      fi
    done
    if [[ -n "$found" ]]; then
      add_check deploy.health_path assertion pass "$found"
    else
      add_check deploy.health_path assertion fail none "neither /health nor /actuator/health reports UP"
    fi
  else
    add_check deploy.health_path assertion skip "" "app not ready"
  fi

  # Boot log scan up to readiness. One error = an ERROR log line or a stack
  # trace header (an exception class at the start of a line); stack frames
  # ("at ...") and "Caused by" lines belong to the error above them.
  local pattern='(^|[[:space:]])ERROR[[:space:]]|^[a-zA-Z_$][a-zA-Z0-9_$.]*(Exception|Error)(:|$)'
  local errors first
  errors=$(grep -cE "$pattern" "$results/app.log" || true)
  errors=${errors:-0}
  first=$(grep -m3 -E "$pattern" "$results/app.log" | cut -c1-200 | paste -sd ';' - || true)
  if [[ "$errors" == 0 ]]; then
    add_check deploy.boot_log_errors assertion pass 0
  else
    add_check deploy.boot_log_errors assertion fail "$errors" "$first"
  fi

  write_results
  [[ "$ready" == true ]]
}

# Right before the tests: if the app no longer answers, record that as a
# readiness failure in deploy.json (infra when the database or mail is down).
check() {
  if app_answers; then
    echo "PASS deploy.ready still answering"
    return 0
  fi
  local problem class="" detail="app stopped answering before the tests"
  problem=$(support_problem)
  [[ -n "$problem" ]] && detail="$detail ($problem)" class=infra
  if [[ -f "$results/deploy.json" ]]; then
    jq --arg detail "$detail" --arg class "$class" \
      '.checks |= map(if .id == "deploy.ready"
        then {id, kind, status: "fail", value: "false", detail: $detail}
          + (if $class == "" then {} else {class: $class} end)
        else . end)' "$results/deploy.json" >"$results/deploy.json.tmp" &&
      mv "$results/deploy.json.tmp" "$results/deploy.json"
  fi
  local word=FAIL
  [[ -n "$class" ]] && word=INCONCLUSIVE
  echo "$word deploy.ready $detail"
  return 1
}

case "$cmd" in
  up) up "${3:-}" ;;
  check) check ;;
  down) compose down --volumes --remove-orphans ;;
  logs) compose logs --follow app ;;
  *)
    echo "unknown command: $cmd" >&2
    exit 2
    ;;
esac
