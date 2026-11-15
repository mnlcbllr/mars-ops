#!/usr/bin/env bash
# MARS-OPS installer.
#
# Installs the MARS-OPS desktop application (and the headless mars-ops-cli)
# from source. The layout matches the layout the official Tauri bundle uses, so
# the installed binary finds its datasets at runtime:
#
#   <prefix>/bin/mars-ops-app
#   <prefix>/bin/mars-ops-cli
#   <prefix>/lib/mars-ops-app/datasets/<dataset-id>
#
# One-liner:
#   curl -fsSL https://raw.githubusercontent.com/mnlcbllr/mars-ops/main/scripts/install.sh | sh
#
# The installer never downloads a binary from a third-party mirror. It builds
# from the repository it is pointed at, so the installed application matches
# the reviewed source.

set -euo pipefail

readonly REPO_DEFAULT="https://github.com/mnlcbllr/mars-ops.git"
readonly APP_NAME="mars-ops-app"
readonly CLI_NAME="mars-ops-cli"
readonly RESOURCE_PKG="mars-ops-app"

PREFIX="${HOME}/.local"
REPO="${REPO_DEFAULT}"
REF=""
SOURCE=""
OFFLINE=0
SKIP_DEPS=0
DRY_RUN=0
VERIFY=1
WORKDIR=""

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

cleanup() {
  if [ -n "${WORKDIR}" ] && [ -d "${WORKDIR}" ]; then
    rm -rf "${WORKDIR}"
  fi
}
trap cleanup EXIT

usage() {
  cat <<'EOF'
MARS-OPS installer

Usage:
  install.sh [options]

Options:
  --prefix DIR     Installation root (default: $HOME/.local)
  --system         Install into /usr/local instead of $HOME/.local
  --source DIR     Build from an existing checkout instead of cloning
  --repo URL       Git repository to clone (default: https://github.com/mnlcbllr/mars-ops.git)
  --ref REF        Git ref to build (default: the default branch)
  --offline        Use only cached Rust and JavaScript packages
  --skip-deps      Do not install system packages or toolchains
  --dry-run        Print what would happen without changing anything
  --no-verify      Skip the post-install verification
  -h, --help       Show this help

Examples:
  curl -fsSL https://raw.githubusercontent.com/mnlcbllr/mars-ops/main/scripts/install.sh | sh
  sh scripts/install.sh --prefix ~/.local --source .
  sh scripts/install.sh --system --skip-deps
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix) [ "$#" -ge 2 ] || die "--prefix needs a value"; PREFIX="$2"; shift 2 ;;
    --prefix=*) PREFIX="${1#*=}"; shift ;;
    --system) PREFIX="/usr/local"; shift ;;
    --source) [ "$#" -ge 2 ] || die "--source needs a value"; SOURCE="$2"; shift 2 ;;
    --source=*) SOURCE="${1#*=}"; shift ;;
    --repo) [ "$#" -ge 2 ] || die "--repo needs a value"; REPO="$2"; shift 2 ;;
    --repo=*) REPO="${1#*=}"; shift ;;
    --ref) [ "$#" -ge 2 ] || die "--ref needs a value"; REF="$2"; shift 2 ;;
    --ref=*) REF="${1#*=}"; shift ;;
    --offline) OFFLINE=1; shift ;;
    --skip-deps) SKIP_DEPS=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --no-verify) VERIFY=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

run() {
  if [ "${DRY_RUN}" -eq 1 ]; then
    printf '\033[2m[dry-run]\033[0m %s\n' "$*"
    return 0
  fi
  "$@"
}

# Write a file as the owner of the prefix, using sudo when the prefix is not
# writable by the current user.
install_file() {
  local src="$1" dest="$2" mode="$3"
  mkdir -p "$(dirname "${dest}")" 2>/dev/null || true
  if [ -w "$(dirname "${dest}")" ]; then
    run install -m "${mode}" "${src}" "${dest}"
  elif have sudo; then
    run sudo install -m "${mode}" "${src}" "${dest}"
  else
    die "cannot write to $(dirname "${dest}") and sudo is unavailable"
  fi
}

# ---------------------------------------------------------------------------
# Host checks
# ---------------------------------------------------------------------------

[ "$(uname -s)" = "Linux" ] || die "this installer supports Linux only"
case "$(uname -m)" in
  x86_64|aarch64) ;;
  *) warn "unusual architecture $(uname -m); the build may fail" ;;
esac

have git || die "git is required"
have curl || have wget || die "curl or wget is required"

# ---------------------------------------------------------------------------
# System packages
# ---------------------------------------------------------------------------

install_system_deps() {
  if [ "${SKIP_DEPS}" -eq 1 ]; then
    log "Skipping system package installation"
    return 0
  fi
  if have pkg-config && pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
    log "Tauri system dependencies already present"
    return 0
  fi
  if [ "${DRY_RUN}" -eq 1 ]; then
    log "Would install Tauri system dependencies"
    return 0
  fi

  local elevate=""
  if [ "$(id -u)" -ne 0 ]; then
    have sudo || die "installing system packages needs root or sudo"
    elevate="sudo"
  fi

  if have apt-get; then
    log "Installing system packages with apt-get"
    ${elevate} apt-get update
    ${elevate} apt-get install -y --no-install-recommends \
      build-essential curl wget file pkg-config libssl-dev \
      libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libxdo-dev
  elif have dnf; then
    log "Installing system packages with dnf"
    ${elevate} dnf install -y gcc gcc-c++ make pkgconf-pkg-config openssl-devel \
      webkit2gtk4.1-devel libappindicator-gtk3-devel librsvg2-devel patchelf file
  elif have pacman; then
    log "Installing system packages with pacman"
    ${elevate} pacman -S --needed --noconfirm base-devel curl wget file pkgconf \
      webkit2gtk-4.1 gtk3 openssl libappindicator-gtk3 librsvg patchelf
  elif have zypper; then
    log "Installing system packages with zypper"
    ${elevate} zypper install -y gcc-c++ make pkg-config libopenssl-devel \
      webkit2gtk4.1-devel libappindicator-gtk3-devel librsvg2-devel patchelf file
  elif have apk; then
    log "Installing system packages with apk"
    ${elevate} apk add --no-cache build-base curl wget file pkgconf \
      webkit2gtk-4.1 gtk3 openssl-dev librsvg patchelf
  else
    die "no supported package manager found; install the Tauri v2 Linux prerequisites by hand and rerun with --skip-deps"
  fi
}

# ---------------------------------------------------------------------------
# Toolchains
# ---------------------------------------------------------------------------

install_rust() {
  if have cargo; then
    return 0
  fi
  log "Installing the Rust toolchain with rustup"
  if [ "${DRY_RUN}" -eq 1 ]; then
    return 0
  fi
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --default-toolchain stable --profile minimal
  export PATH="${HOME}/.cargo/bin:${PATH}"
}

install_bun() {
  if have bun; then
    return 0
  fi
  log "Installing Bun"
  if [ "${DRY_RUN}" -eq 1 ]; then
    return 0
  fi
  if have npm; then
    npm install -g bun >/dev/null
  else
    curl -fsSL https://bun.sh/install | bash >/dev/null
    export PATH="${HOME}/.bun/bin:${PATH}"
  fi
  have bun || die "Bun installation failed"
}

# ---------------------------------------------------------------------------
# Source
# ---------------------------------------------------------------------------

prepare_source() {
  if [ -n "${SOURCE}" ]; then
    [ -d "${SOURCE}" ] || die "--source directory not found: ${SOURCE}"
    SRC="$(cd "${SOURCE}" && pwd)"
    log "Building from the local checkout at ${SRC}"
    return 0
  fi
  have git || die "git is required to clone ${REPO}"
  WORKDIR="$(mktemp -d)"
  SRC="${WORKDIR}/src"
  log "Cloning ${REPO} into ${SRC}"
  if [ -n "${REF}" ]; then
    run git clone --depth 1 --branch "${REF}" "${REPO}" "${SRC}"
  else
    run git clone --depth 1 "${REPO}" "${SRC}"
  fi
}

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

build_frontend() {
  if [ ! -d "${SRC}/node_modules" ]; then
    [ "${OFFLINE}" -eq 0 ] || die "offline install needs an existing node_modules directory"
    log "Installing JavaScript dependencies with Bun"
    run bash -c "cd '${SRC}' && bun install --frozen-lockfile"
  else
    log "Reusing the JavaScript dependencies in ${SRC}/node_modules"
  fi
  log "Building the frontend"
  run bash -c "cd '${SRC}' && bun run build"
}

build_backend() {
  log "Building the Rust backend (release)"
  local offline_flag=""
  [ "${OFFLINE}" -eq 1 ] && offline_flag="--offline"
  # The custom-protocol feature makes the app serve the embedded frontend.
  # Without it the binary looks for the development server and shows an empty
  # window on a machine that has no dev server running.
  run bash -c "cd '${SRC}' && cargo build --release ${offline_flag} -p ${APP_NAME} --features custom-protocol"
  run bash -c "cd '${SRC}' && cargo build --release ${offline_flag} -p ${CLI_NAME}"
}

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------

install_payload() {
  local bin_dir="${PREFIX}/bin"
  local lib_dir="${PREFIX}/lib/${RESOURCE_PKG}"

  log "Installing the application into ${PREFIX}"
  install_file "${SRC}/target/release/${APP_NAME}" "${bin_dir}/${APP_NAME}" "755"
  install_file "${SRC}/target/release/${CLI_NAME}" "${bin_dir}/${CLI_NAME}" "755"

  log "Installing the bundled datasets into ${lib_dir}/datasets"
  run bash -c "rm -rf '${lib_dir}/datasets' && mkdir -p '${lib_dir}/datasets'"
  local dataset name
  for dataset in "${SRC}"/datasets/*/; do
    [ -d "${dataset}" ] || continue
    [ -f "${dataset}/manifest.json" ] || continue
    name="$(basename "${dataset}")"
    if [ "${DRY_RUN}" -eq 1 ]; then
      printf '\033[2m[dry-run]\033[0m copy %s -> %s\n' "${dataset}" "${lib_dir}/datasets/${name}"
    elif [ -w "${lib_dir}/datasets" ]; then
      run bash -c "rm -rf '${lib_dir}/datasets/${name}' && cp -a '${dataset}' '${lib_dir}/datasets/${name}'"
    elif have sudo; then
      run bash -c "sudo rm -rf '${lib_dir}/datasets/${name}' && sudo cp -a '${dataset}' '${lib_dir}/datasets/${name}'"
    else
      die "cannot write ${lib_dir}/datasets and sudo is unavailable"
    fi
  done

  if [ -f "${SRC}/src-tauri/icons/128x128@2x.png" ]; then
    install_file "${SRC}/src-tauri/icons/128x128@2x.png" \
      "${PREFIX}/share/icons/hicolor/256x256/apps/mars-ops.png" "644"
  fi

  log "Writing the desktop entry"
  local desktop_file="${PREFIX}/share/applications/mars-ops.desktop"
  mkdir -p "$(dirname "${desktop_file}")" 2>/dev/null || true
  local desktop_body
  desktop_body="$(printf '[Desktop Entry]\nType=Application\nName=MARS-OPS\nComment=Mars terrain viewer and contingency-aware excursion planner\nExec=%s\nIcon=mars-ops\nTerminal=false\nCategories=Science;Education;\n' "${bin_dir}/${APP_NAME}")"
  if [ "${DRY_RUN}" -eq 1 ]; then
    printf '%s\n' "${desktop_body}"
  elif [ -w "$(dirname "${desktop_file}")" ]; then
    printf '%s\n' "${desktop_body}" > "${desktop_file}"
  elif have sudo; then
    printf '%s\n' "${desktop_body}" | sudo tee "${desktop_file}" >/dev/null
  else
    warn "cannot write ${desktop_file}; the desktop entry was skipped"
  fi
}

# ---------------------------------------------------------------------------
# Verify
# ---------------------------------------------------------------------------

verify_install() {
  [ "${VERIFY}" -eq 1 ] || return 0
  log "Verifying the installation"
  local app="${PREFIX}/bin/${APP_NAME}"
  local cli="${PREFIX}/bin/${CLI_NAME}"
  local data="${PREFIX}/lib/${RESOURCE_PKG}/datasets/jezero-small"

  [ -x "${app}" ] || die "the application binary is missing at ${app}"
  [ -x "${cli}" ] || die "the command line tool is missing at ${cli}"
  [ -f "${data}/manifest.json" ] || die "the dataset is missing at ${data}"

  if have ldd; then
    local missing
    missing="$(ldd "${app}" 2>/dev/null | grep 'not found' || true)"
    [ -z "${missing}" ] || warn "the application links against missing libraries: ${missing}"
  fi

  local verified
  if verified="$("${cli}" verify-manifest "${data}" 2>&1)"; then
    printf '%s\n' "${verified}" | tail -3
    log "Dataset manifest verified"
  else
    printf '%s\n' "${verified}" | tail -3
    warn "the dataset manifest check did not confirm the data"
  fi
}

# ---------------------------------------------------------------------------

main() {
  install_system_deps
  install_rust
  install_bun
  prepare_source
  build_frontend
  build_backend
  install_payload
  verify_install

  log "MARS-OPS is installed"
  printf '\n  Application : %s\n' "${PREFIX}/bin/${APP_NAME}"
  printf '  Command line: %s\n' "${PREFIX}/bin/${CLI_NAME}"
  printf '  Datasets    : %s\n' "${PREFIX}/lib/${RESOURCE_PKG}/datasets"
  printf '  Start it    : %s\n' "${PREFIX}/bin/${APP_NAME}"
  case ":${PATH}:" in
    *":${PREFIX}/bin:"*) ;;
    *) printf '\n  Add %s to your PATH.\n' "${PREFIX}/bin" ;;
  esac
}

main "$@"
