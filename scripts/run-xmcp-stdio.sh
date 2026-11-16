#!/bin/sh
set -eu

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

# Resolve real script path even when plugin directory is symlinked
SOURCE="$0"
while [ -L "$SOURCE" ]; do
  DIR="$(CDPATH= cd -- "$(dirname -- "$SOURCE")" && pwd)"
  TARGET="$(readlink "$SOURCE")"
  case "$TARGET" in
    /*) SOURCE="$TARGET" ;;
    *) SOURCE="$DIR/$TARGET" ;;
  esac
done
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$SOURCE")" && pwd)"
PKG_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"

for VENV_PY in \
  "$PKG_ROOT/.venv/bin/python" \
  "$PKG_ROOT/../../xdevplatform/xmcp/.venv/bin/python" \
  "$HOME/.local/share/xmcp/.venv/bin/python"
do
  if [ -x "$VENV_PY" ]; then
    exec "$VENV_PY" "$SCRIPT_DIR/xmcp-stdio.py"
  fi
done

if command -v uv >/dev/null 2>&1; then
  exec uv run --quiet --with fastmcp --with httpx --with requests --with requests-oauthlib python3 "$SCRIPT_DIR/xmcp-stdio.py"
fi

exec python3 "$SCRIPT_DIR/xmcp-stdio.py"
