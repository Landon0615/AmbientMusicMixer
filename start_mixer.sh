#!/bin/sh
# Ambient Music Mixer for Linux.  Usage: ./start_mixer.sh [--lan] [--port 8765]
# Default: only this machine (127.0.0.1). On a headless server either use --lan (trusted LAN only, no password)
# or keep the default and tunnel:  ssh -L 8765:localhost:8765 user@server   then open http://localhost:8765/
cd "$(dirname "$0")/mixer" || exit 1
PY=$(command -v python3 || command -v python)
if [ -z "$PY" ] || ! "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'; then
  echo "Python 3.8 or newer is required (e.g. sudo apt install python3)."
  exit 1
fi
exec "$PY" mixer_server.py "$@"
