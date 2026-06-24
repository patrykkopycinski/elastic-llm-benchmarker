#!/usr/bin/env bash
# Backward-compatible wrapper — prefer pull-dra-es-image.sh
exec "$(dirname "$0")/pull-dra-es-image.sh" "$@"
