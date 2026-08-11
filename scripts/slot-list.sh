#!/usr/bin/env bash
# slot-list.sh — the source of truth for "which slots does the single
# WorkshopPlatformStack currently contain".
#
# WHY THIS EXISTS (epic #180 / #181 / #184):
# The platform stack is now ONE stack whose nested ParticipantStacks are driven
# by the WORKSHOP_SLOTS list passed to `cdk deploy`. That list is authoritative:
# any slot NOT in it on the next deploy is REMOVED from the stack. So a naive
# `cdk deploy` with only the one slot you're adding would silently tear down
# every other slot. To make add-one / remove-one safe, the *union* of active
# slots is persisted in SSM at /workshop/platform/active-slots (comma-separated)
# and every deploy uses the merged list. This SSM param is the trade-off that
# replaces the old per-slot top-level stacks (see workshop/reference/decisions).
#
# Source this file, then call:
#   slots_get                      -> echoes current comma-separated list (may be empty)
#   slots_add   ws-slot00 [more..] -> merge args into the list, echo the merged list
#   slots_remove ws-slot00 [more..]-> drop args from the list, echo the remaining list
#   slots_put   ws-slot00,ws-slot01-> overwrite the list verbatim
#
# All persist to SSM. Every function also prints the resulting list to stdout so
# callers can capture it for `WORKSHOP_SLOTS=`.

set -euo pipefail

SLOTS_SSM_PARAM="${SLOTS_SSM_PARAM:-/workshop/platform/active-slots}"

# Normalise a comma/space separated slot list to a sorted, de-duplicated,
# comma-separated string.
_slots_normalise() {
  tr ', ' '\n\n' \
    | grep -E '^ws-slot[0-9]{2}$' \
    | sort -u \
    | paste -sd, -
}

slots_get() {
  aws ssm get-parameter --name "$SLOTS_SSM_PARAM" \
    --query "Parameter.Value" --output text 2>/dev/null \
    | _slots_normalise || true
}

slots_put() {
  local list
  list=$(printf '%s' "$1" | _slots_normalise)
  aws ssm put-parameter --name "$SLOTS_SSM_PARAM" --type String \
    --overwrite --value "${list:-}" >/dev/null
  printf '%s' "$list"
}

slots_add() {
  local current merged
  current=$(slots_get)
  merged=$(printf '%s,%s' "$current" "$*" | _slots_normalise)
  slots_put "$merged"
}

slots_remove() {
  local current drop remaining
  current=$(slots_get)
  drop=$(printf '%s' "$*" | tr ', ' '\n\n')
  # Keep every current slot that is not in the drop set.
  remaining=$(comm -23 \
    <(printf '%s' "$current" | tr ',' '\n' | sort -u) \
    <(printf '%s\n' "$drop" | sort -u) \
    | _slots_normalise)
  slots_put "$remaining"
}
