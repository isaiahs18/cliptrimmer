#!/bin/bash
set -e

# ── Clip Trimmer startup script ───────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Check .env exists
if [ ! -f .env ]; then
  echo "ERROR: .env file not found."
  echo "Copy .env.example to .env and fill in your Google OAuth credentials."
  echo "  cp .env.example .env"
  exit 1
fi

# Check ffmpeg
if ! command -v ffmpeg &>/dev/null; then
  echo "ERROR: ffmpeg not found. Install it with: sudo apt install ffmpeg"
  exit 1
fi

# Create venv if needed
if [ ! -d venv ]; then
  echo "Creating virtual environment…"
  python3 -m venv venv
fi

source venv/bin/activate

# Install / upgrade dependencies quietly
pip install -q --upgrade pip
pip install -q -r requirements.txt

mkdir -p /tmp/cliptrimmer

echo ""
echo "────────────────────────────────────────────────"
echo "  Clip Trimmer running at http://0.0.0.0:8080"
echo "  Access from your network: http://$(hostname -I | awk '{print $1}'):8080"
echo "────────────────────────────────────────────────"
echo ""

uvicorn main:app --host 0.0.0.0 --port 8080
