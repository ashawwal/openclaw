#!/usr/bin/env bash

run_ios_fastlane() {
  local gemfile="${BUNDLE_GEMFILE:-}"
  if [[ "${OPENCLAW_IOS_FASTLANE_USE_AMBIENT:-0}" != "1" ]]; then
    local repo_gemfile=""
    repo_gemfile="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/apps/ios/Gemfile"
    if [[ -f "$repo_gemfile" ]]; then
      gemfile="$repo_gemfile"
    fi
  fi

  if [[ "${OPENCLAW_IOS_FASTLANE_USE_AMBIENT:-0}" != "1" && -n "$gemfile" ]]; then
    if ! command -v bundle >/dev/null 2>&1; then
      echo "bundle not found for BUNDLE_GEMFILE=${gemfile}." >&2
      return 127
    fi
    BUNDLE_GEMFILE="$gemfile" bundle exec fastlane "$@"
    return $?
  fi

  if command -v fastlane >/dev/null 2>&1 && fastlane --version >/dev/null 2>&1; then
    fastlane "$@"
    return $?
  fi

  if command -v rbenv >/dev/null 2>&1; then
    local version=""
    while IFS= read -r version; do
      if RBENV_VERSION="${version}" rbenv which fastlane >/dev/null 2>&1; then
        RBENV_VERSION="${version}" rbenv exec fastlane "$@"
        return $?
      fi
    done < <(rbenv versions --bare)
  fi

  echo "fastlane not found. Install fastlane or select a Ruby version that has the fastlane gem." >&2
  return 127
}
