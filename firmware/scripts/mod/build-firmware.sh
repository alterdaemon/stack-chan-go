#!/usr/bin/env bash
set -euo pipefail
unset BASH_ENV
PROJECT_ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
TOOLCHAINS="${STACKCHAN_TOOLCHAINS:?Set STACKCHAN_TOOLCHAINS to the directory containing Moddable, ESP-IDF and esp-webrtc-solution}"
export MODDABLE="$TOOLCHAINS/moddable"
export IDF_PATH="$TOOLCHAINS/esp-idf"
export IDF_TOOLS_PATH="$TOOLCHAINS/idf-tools"
export ESP_WEBRTC_SOLUTION="$TOOLCHAINS/esp-webrtc-solution"
export FONTBM="$TOOLCHAINS/fontbm/build/fontbm"
export PATH="$MODDABLE/build/bin/lin/release:$PATH"
export MAKEFLAGS="-j4 SHELL=/bin/sh"
. "$IDF_PATH/export.sh"
cd "$PROJECT_ROOT/firmware"
npm run build -- "$@"
