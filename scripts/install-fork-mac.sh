#!/usr/bin/env bash
# Installs a fork desktop build on macOS. The fork's builds are not Developer ID signed,
# so a browser download gets quarantined and Gatekeeper refuses it; gh downloads are not
# quarantined, which lets the app open without clearing attributes by hand. The release
# manifest's sha512 stands in for the signature check those builds cannot pass.
set -euo pipefail

repo="${T3_FORK_REPO:-ethanlee66/t3code}"
dest="/Applications"
tag=""
force=0
assume_yes=0
relaunch=1
bundle_id="com.t3tools.t3code"

usage() {
  cat <<EOF
Usage: scripts/install-fork-mac.sh [options]

Downloads the newest $repo desktop release for this Mac and installs it.

Options:
  --tag <tag>       Install this release tag instead of the newest one
  --dest <dir>      Install into <dir> (default: /Applications)
  --force           Reinstall even when that version is already installed
  --yes             Quit a running T3 Code without asking
  --no-relaunch     Do not open the app after installing
  -h, --help        Show this help

Set T3_FORK_REPO=<owner/repo> to install from another fork.
EOF
}

while (($#)); do
  case "$1" in
    --tag) tag="${2:?--tag needs a value}"; shift 2 ;;
    --dest) dest="${2:?--dest needs a value}"; shift 2 ;;
    --force) force=1; shift ;;
    --yes) assume_yes=1; shift ;;
    --no-relaunch) relaunch=0; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

die() { echo "error: $*" >&2; exit 1; }
step() { echo "==> $*"; }

[[ "$(uname -s)" == "Darwin" ]] || die "this installer is for macOS."
command -v gh >/dev/null || die "gh is required (brew install gh, then gh auth login)."
[[ -d "$dest" ]] || die "$dest does not exist."

case "$(uname -m)" in
  arm64) arch="arm64" ;;
  x86_64) arch="x64" ;;
  *) die "unsupported architecture $(uname -m)." ;;
esac

if [[ -z "$tag" ]]; then
  tag="$(gh release list --repo "$repo" --limit 20 --exclude-drafts --json tagName --jq '.[0].tagName')"
  [[ -n "$tag" ]] || die "no releases found in $repo."
fi
version="${tag#v}"
zip_name="T3-Code-${version}-${arch}.zip"

running_from() {
  ps -axo comm= | grep -Fq "$1/Contents/MacOS/"
}

installed_app=""
for candidate in "$dest"/T3\ Code*.app; do
  [[ -d "$candidate" ]] || continue
  if [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$candidate/Contents/Info.plist" 2>/dev/null)" == "$bundle_id" ]]; then
    installed_app="$candidate"
    break
  fi
done
if [[ -n "$installed_app" && "$force" == 0 ]]; then
  installed_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$installed_app/Contents/Info.plist" 2>/dev/null || true)"
  if [[ "$installed_version" == "$version" ]]; then
    echo "$(basename "$installed_app") $version is already installed. Use --force to reinstall."
    exit 0
  fi
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/t3-fork-install.XXXXXX")"
trap 'rm -rf "$work"' EXIT

step "Downloading $zip_name from $repo@$tag"
gh release download "$tag" --repo "$repo" --dir "$work" --pattern "$zip_name" --pattern "*-mac.yml" \
  || die "could not download $zip_name; does $tag have a macOS $arch build?"
[[ -f "$work/$zip_name" ]] || die "$tag has no $zip_name."

manifest="$(find "$work" -maxdepth 1 -name '*-mac.yml' | head -n 1)"
if [[ -n "$manifest" ]]; then
  expected="$(awk -v name="$zip_name" '
    $1 == "-" && $2 == "url:" { current = $3 }
    $1 == "sha512:" && current == name { print $2; exit }
  ' "$manifest")"
  if [[ -n "$expected" ]]; then
    actual="$(shasum -a 512 "$work/$zip_name" | awk '{print $1}' | xxd -r -p | base64)"
    [[ "$actual" == "$expected" ]] || die "checksum mismatch for $zip_name."
    step "Checksum verified"
  fi
fi

step "Unpacking"
ditto -x -k "$work/$zip_name" "$work/unpacked"
new_app="$(find "$work/unpacked" -maxdepth 1 -name '*.app' -type d | head -n 1)"
[[ -n "$new_app" ]] || die "the archive has no .app bundle."
target="$dest/$(basename "$new_app")"

if running_from "$target"; then
  if [[ "$assume_yes" == 0 ]]; then
    echo "$(basename "$target") is running. Quitting it stops agent turns running on this Mac."
    read -r -p "Quit it and install $version? [y/N] " reply
    [[ "$reply" == [yY]* ]] || die "cancelled."
  fi
  step "Quitting $(basename "$target")"
  osascript -e "tell application \"$target\" to quit" >/dev/null 2>&1 || true
  for _ in $(seq 1 60); do
    running_from "$target" || break
    sleep 0.5
  done
  running_from "$target" && die "$(basename "$target") did not quit; quit it and run this again."
fi

step "Installing $(basename "$new_app") $version into $dest"
backup=""
if [[ -e "$target" ]]; then
  backup="$work/previous.app"
  mv "$target" "$backup"
fi
if ! ditto "$new_app" "$target"; then
  rm -rf "$target"
  [[ -n "$backup" ]] && mv "$backup" "$target"
  die "copy failed; the previous version was restored."
fi
xattr -dr com.apple.quarantine "$target" 2>/dev/null || true

echo "Installed $(basename "$target") $version."
if [[ "$relaunch" == 1 ]]; then
  open "$target"
fi
