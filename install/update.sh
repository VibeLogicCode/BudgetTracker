#!/usr/bin/env bash
# Budget Tracker — manual update with automatic rollback.
#
# Deliberately MANUAL ONLY (spec section 9): no scheduler, no auto-update
# (the prebuilt-image install has an opt-in in-app check; this is the
# build-from-source path). You run this when you want to.
#
# Dependency updates are SEMVER-SAFE: npm update stays inside the lockfile's
# caret ranges, so patch and minor only. Major upgrades are never taken
# automatically — those stay a deliberate, reviewed change.
#
# /data is never touched by any branch of this script, including the rollback.
set -euo pipefail

SERVICE="budget-tracker"
IMAGE="budget-tracker:latest"
ROLLBACK_IMAGE="budget-tracker:previous"
BASE_IMAGE="node:22-bookworm-slim"
HEALTH_TIMEOUT=120

DRY_RUN=0
SKIP_GIT=0
SKIP_DEPS=0
SKIP_PULL=0
SKIP_BACKUP=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

usage() {
  cat <<'EOF'
Budget Tracker updater — manual, semver-safe, self-rolling-back

Usage: install/update.sh [options]

Options:
  --dry-run    Print every action, including the rollback branch, without doing any of them.
  --skip-git   Do not run "git pull" even if this is a git checkout.
  --no-pull    Do not refresh the base image.
  --no-deps    Do not run "npm update" (patch/minor dependency refresh).
  --skip-backup  Do not take a backup before upgrading. Not recommended: the
               rollback below restores the IMAGE, never the database.
  --help       Show this message.

What it does, in order:
  1. git pull --ff-only        (only when .git exists and --skip-git was not given)
  2. docker pull node:22-bookworm-slim   (base-image security fixes)
  3. npm update                (PATCH AND MINOR ONLY — majors are never automatic)
  4. tag the running image as budget-tracker:previous   (the rollback point)
  5. take a verified backup, inside the running container  (--skip-backup to omit)
  6. docker compose build
  7. docker compose up -d
  8. poll the container's own health status via "docker inspect" (this is
     independent of any --port remap done at install time — it reads the
     container's internal /api/health check, not a host URL)
  9. AUTO-ROLLBACK if it never becomes healthy: restore budget-tracker:previous,
     restart, re-verify, print the logs, exit non-zero.

There is no scheduler and no automatic update. Run this by hand.
Major dependency upgrades stay manual and reviewed.
Your /data directory is never touched, in any branch, except to ADD the backup
taken at step 5 -- nothing existing is modified or removed.
If a rollback happens, any git pull / npm update from this run are left in
your working tree — see the ROLLBACK message for exact recovery commands.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --skip-git) SKIP_GIT=1; shift ;;
    --no-deps) SKIP_DEPS=1; shift ;;
    --no-pull) SKIP_PULL=1; shift ;;
    --skip-backup) SKIP_BACKUP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; echo >&2; usage >&2; exit 2 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    say "[dry-run] would run: $*"
  else
    "$@"
  fi
}

app_version() {
  sed -nE 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "${PROJECT_DIR}/package.json" | head -n1
}

dependency_fingerprint() {
  if [ -f "${PROJECT_DIR}/package-lock.json" ]; then
    if command -v shasum >/dev/null 2>&1; then
      shasum -a 256 "${PROJECT_DIR}/package-lock.json" | cut -c1-12
    elif command -v sha256sum >/dev/null 2>&1; then
      sha256sum "${PROJECT_DIR}/package-lock.json" | cut -c1-12
    else
      printf 'unknown'
    fi
  else
    printf 'none'
  fi
}

# Port-independent by design: this checks the CONTAINER's own healthcheck
# status (the same one docker-compose.yml defines against 127.0.0.1:3000
# *inside* the container) rather than curling a host URL. A curl-to-host-port
# approach would hardcode :3000 here and falsely report "unhealthy" (triggering
# an unwanted auto-rollback) on any install that used --port to remap the host
# side, since the container's internal port never changes.
wait_for_health() {
  say "Waiting for the ${SERVICE} container to report healthy (docker inspect) for up to ${HEALTH_TIMEOUT} seconds"
  if [ "$DRY_RUN" -eq 1 ]; then
    say "[dry-run] would run: docker inspect --format '{{.State.Health.Status}}' ${SERVICE}"
    return 0
  fi
  local waited=0
  while [ "$waited" -lt "$HEALTH_TIMEOUT" ]; do
    local status
    status="$(docker inspect --format '{{.State.Health.Status}}' "$SERVICE" 2>/dev/null || printf 'unknown')"
    case "$status" in
      healthy) say "Healthy after ${waited}s."; return 0 ;;
      unhealthy) warn "Container reported unhealthy after ${waited}s."; return 1 ;;
    esac
    sleep 3
    waited=$((waited + 3))
  done
  return 1
}

warn_dirty_tree() {
  warn "Any git pull / npm update changes from this run are still in your working tree."
  warn "Rebuilding from here would reproduce the same broken image. Before trying again:"
  warn "  git checkout -- package.json package-lock.json   # discard the dependency bump, or: git stash"
  warn "  then investigate the failure and re-run install/update.sh when ready."
}

rollback() {
  step "ROLLBACK — the updated image never became healthy"
  say "Recent logs from the failed container:"
  if [ "$DRY_RUN" -eq 1 ]; then
    say "[dry-run] would run: docker compose logs --tail 40 ${SERVICE}"
  else
    docker compose logs --tail 40 "$SERVICE" || true
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    say "[dry-run] would check: docker image inspect ${ROLLBACK_IMAGE}"
  elif ! docker image inspect "$ROLLBACK_IMAGE" >/dev/null 2>&1; then
    warn "No rollback point exists (${ROLLBACK_IMAGE} was never tagged — this looks like the very first build)."
    warn "The update has been left in place, unhealthy. Investigate with: docker compose logs ${SERVICE}"
    warn_dirty_tree
    return 1
  fi

  say "Restoring the previous image"
  run docker tag "$ROLLBACK_IMAGE" "$IMAGE"
  say "Running: docker compose up -d"
  run docker compose up -d

  if wait_for_health; then
    say "Rolled back successfully — you are running the previous version again."
    say "Your /data was never touched. Nothing was lost."
  else
    warn "The rollback also failed to report healthy. Investigate with:"
    say "  docker compose logs ${SERVICE}"
  fi
  warn "Update aborted and rolled back."
  warn_dirty_tree
  return 1
}

cd "$PROJECT_DIR"
[ "$DRY_RUN" -eq 0 ] || say "*** DRY RUN — nothing will be changed. ***"
say "This updater is manual only: no scheduler, no auto-update. (The prebuilt-image install has an opt-in in-app update check at Settings -> About; this script is the build-from-source path and is unaffected by it.)"

BEFORE_VERSION="$(app_version)"
BEFORE_DEPS="$(dependency_fingerprint)"
step "Before — app version ${BEFORE_VERSION:-unknown}, lockfile ${BEFORE_DEPS}"

step "Step 1/9 — new source"
if [ "$SKIP_GIT" -eq 1 ]; then
  say "Skipped (--skip-git)."
elif [ -d "${PROJECT_DIR}/.git" ]; then
  say "Running: git pull --ff-only"
  run git pull --ff-only
else
  warn "This is not a git checkout, so there is nothing to pull."
  say "Copy the new source over this folder first if you are updating the app itself."
  say "Your ./data and .env are safe: only source files need replacing."
fi

step "Step 2/9 — base image refresh"
if [ "$SKIP_PULL" -eq 1 ]; then
  say "Skipped (--no-pull)."
else
  say "Running: docker pull ${BASE_IMAGE}"
  run docker pull "$BASE_IMAGE"
fi

step "Step 3/9 — semver-safe dependency update (patch and minor only)"
if [ "$SKIP_DEPS" -eq 1 ]; then
  say "Skipped (--no-deps)."
else
  say "Running: npm update"
  say "Major version bumps are NOT taken here — they stay a manual, reviewed change."
  run npm update
fi

step "Step 4/9 — tagging the rollback point"
say "Running: docker tag ${IMAGE} ${ROLLBACK_IMAGE}"
if [ "$DRY_RUN" -eq 1 ]; then
  say "[dry-run] would run: docker tag ${IMAGE} ${ROLLBACK_IMAGE}"
else
  if docker image inspect "$IMAGE" >/dev/null 2>&1; then
    docker tag "$IMAGE" "$ROLLBACK_IMAGE"
    say "Rollback point saved as ${ROLLBACK_IMAGE}."
  else
    warn "No existing ${IMAGE} to tag — this looks like a first build, so there is nothing to roll back to."
  fi
fi

# O-05 (2026-09-02 review). A fresh restore point BEFORE the swap, while the OLD container is
# still up and can take one. Runs `npm run backup` INSIDE that container, so the backup logic is
# the same Node code the in-app Update button uses -- one implementation, not a second one written
# in bash and a third in PowerShell. See src/lib/backup/pre-upgrade.ts.
#
# Aborts on failure: no backup means no way back, and the rollback path below only re-tags the old
# IMAGE -- it has never restored the database. --skip-backup is the deliberate override.
step "Step 5/9 — backup"
if [ "$SKIP_BACKUP" -eq 1 ]; then
  warn "Skipping the pre-upgrade backup (--skip-backup). There will be no restore point from just before this upgrade."
elif [ "$DRY_RUN" -eq 1 ]; then
  say "[dry-run] would run: docker compose exec -T app npm run --silent backup"
else
  say "Running: docker compose exec -T app npm run --silent backup"
  if BACKUP_PATH=$(docker compose exec -T app npm run --silent backup); then
    say "Backup written to ${BACKUP_PATH}."
  else
    echo "The pre-upgrade backup failed, so the update stopped before changing anything." >&2
    echo "Fix the cause (usually disk space) and run this again, or pass --skip-backup to proceed without one." >&2
    exit 1
  fi
fi

step "Step 6/9 — rebuilding"
say "Running: docker compose build"
run docker compose build

step "Step 7/9 — restarting"
say "Running: docker compose up -d"
run docker compose up -d

step "Step 8/9 — health check"
if wait_for_health; then
  say "The updated container is healthy."
else
  step "Step 9/9 — health check FAILED, rolling back"
  rollback || exit 1
  exit 1
fi

step "Step 9/9 — done"
AFTER_VERSION="$(app_version)"
AFTER_DEPS="$(dependency_fingerprint)"
say "App version: ${BEFORE_VERSION:-unknown} -> ${AFTER_VERSION:-unknown}"
if [ "$BEFORE_DEPS" = "$AFTER_DEPS" ]; then
  say "Dependencies: unchanged (${AFTER_DEPS})"
else
  say "Dependencies: updated (${BEFORE_DEPS} -> ${AFTER_DEPS}) — patch/minor only"
fi
say "/data was untouched — the database, backups and .env are exactly as they were."
say "Watch the logs with: docker compose logs -f ${SERVICE}"
