#!/usr/bin/env bash
set -euo pipefail
unset BASH_ENV
PROJECT_ROOT=$(cd "$(dirname "$0")" && pwd)
TOOLCHAINS="${STACKCHAN_TOOLCHAINS:-/home/alterdaemon/.var/app/io.github.alterdaemon.chatgpt-desktop-unofficial-flatpak/data/codex-home/projectless/2026-11-09/referenced-chatgpt-conversation-this-is-an/work/toolchains}"
export MODDABLE="$TOOLCHAINS/moddable"
export IDF_PATH="$TOOLCHAINS/esp-idf"
export IDF_TOOLS_PATH="$TOOLCHAINS/idf-tools"
export ESP_WEBRTC_SOLUTION="$TOOLCHAINS/esp-webrtc-solution"
export STACKCHAN_REALTIME_WEBRTC=1
export FONTBM="$TOOLCHAINS/fontbm/build/fontbm"
export PATH="$MODDABLE/build/bin/lin/release:$PATH"
export MAKEFLAGS="-j4 SHELL=/bin/sh"
. "$IDF_PATH/export.sh"
cd "$PROJECT_ROOT/firmware"
npm run build -- --mode=release --manifest host/app/manifest_openai_live_integrated.json
