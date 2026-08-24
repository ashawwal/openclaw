#!/usr/bin/env bash

run_ios_fastlane() {
  local repo_gemfile=""
  repo_gemfile="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/apps/ios/Gemfile"

  local gemfile="${BUNDLE_GEMFILE:-}"
  if [[ -f "$repo_gemfile" ]]; then
    gemfile="$repo_gemfile"
  fi

  if [[ -n "$gemfile" ]]; then
    local setup_hint=""
    setup_hint="Install Ruby 3.4.10, then run: cd apps/ios && gem install bundler -v 2.6.9 && bundle _2.6.9_ install"
    if ! command -v bundle >/dev/null 2>&1; then
      echo "bundle not found for the iOS Fastlane bundle at ${gemfile}." >&2
      echo "$setup_hint" >&2
      return 127
    fi
    if ! BUNDLE_GEMFILE="$gemfile" bundle check >/dev/null 2>&1; then
      echo "The iOS Fastlane bundle is not installed for ${gemfile}." >&2
      echo "$setup_hint" >&2
      return 1
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
