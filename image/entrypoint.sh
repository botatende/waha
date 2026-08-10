#!/bin/bash
set -e

cd /app

echo "=== WAHA + WEBJS + VNC PoC (non-headless) ==="

# Remove old X lock files
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null

# Start main Xvfb (:99) for backward compatibility
Xvfb :99 -screen 0 1280x1024x24 -ac +extension GLX +render &
XVFB_PID=$!
sleep 2

if ! kill -0 $XVFB_PID 2>/dev/null; then
    echo "ERROR: Xvfb :99 failed to start"
    exit 1
fi
echo "Xvfb running (PID $XVFB_PID) on :99"

# Start x11vnc for display :99
x11vnc -display :99 -forever -shared -rfbport 5900 -nopw -listen 0.0.0.0 &
X11VNC_PID=$!
echo "x11vnc running (PID $X11VNC_PID) on port 5900"

# Start noVNC for display :99
/usr/share/novnc/utils/novnc_proxy --listen 6080 --vnc localhost:5900 &
NOVNC_PID=$!
echo "noVNC running (PID $NOVNC_PID) on port 6080"

echo "---"
echo "Default noVNC: http://localhost:6080/vnc.html"
echo "---"

# ========== Per-session VNC Pool (displays 20-29) ==========
# Each session gets its own display for WAHA's Chrome (non-headless)
# Xvfb :20-:29 → x11vnc 5920-5929 → noVNC 7020-7029
DISPLAY_START=${DISPLAY_START:-20}
VNC_RFB_START=${VNC_RFB_START:-5920}
VNC_WEB_START=${VNC_WEB_START:-7020}
MAX_POOL_SLOTS=${MAX_POOL_SLOTS:-10}

VNC_POOL_PIDS=""
for SLOT in $(seq 0 $((MAX_POOL_SLOTS - 1))); do
  DISP_NUM=$((DISPLAY_START + SLOT))
  RFB_PORT=$((VNC_RFB_START + SLOT))
  WEB_PORT=$((VNC_WEB_START + SLOT))

  Xvfb :${DISP_NUM} -screen 0 1366x768x24 -ac +extension GLX +render &
  sleep 1

  x11vnc -display :${DISP_NUM} -forever -shared -rfbport ${RFB_PORT} -nopw -listen 0.0.0.0 &
  sleep 0.3

  /usr/share/novnc/utils/novnc_proxy --listen ${WEB_PORT} --vnc localhost:${RFB_PORT} &
  sleep 0.3

  VNC_POOL_PIDS="${VNC_POOL_PIDS} $!"
  echo "  Slot ${SLOT}: display :${DISP_NUM}, x11vnc ${RFB_PORT}, noVNC ${WEB_PORT}"
done

echo "VNC pool ready (${MAX_POOL_SLOTS} slots)"
echo "---"

export DISPLAY=:99

# Calculate UV_THREADPOOL_SIZE
CPUS=$(node -e "const os = require('os'); console.log(os.cpus().length);" 2>/dev/null || echo 1)
case $CPUS in ''|*[!0-9]*) CPUS=1 ;; esac
TPS=$((CPUS * 2))
[ "$TPS" -lt 4 ] && TPS=4
export UV_THREADPOOL_SIZE="${UV_THREADPOOL_SIZE:-$TPS}"

# Handle API key hashing
if [ -n "$WHATSAPP_API_KEY" ]; then
  KEY="$WHATSAPP_API_KEY"
elif [ -n "$WAHA_API_KEY" ]; then
  KEY="$WAHA_API_KEY"
fi
unset WHATSAPP_API_KEY
unset WAHA_API_KEY
if [ -n "$KEY" ]; then
  if echo "$KEY" | grep -q "^sha512:"; then
    export WAHA_API_KEY="$KEY"
  else
    HASHED_KEY=$(echo -n "$KEY" | sha512sum | awk '{print $1}')
    export WAHA_API_KEY="sha512:${HASHED_KEY}"
  fi
fi

echo "Iniciando WAHA (WEBJS non-headless)..."
echo "VNC pool: http://localhost:${VNC_WEB_START}/vnc.html (slot 0)"
echo "---"

# Run node in foreground (keep bg processes alive)
node dist/main
NODE_EXIT=$?

echo "WAHA exit code: $NODE_EXIT"
kill $XVFB_PID $X11VNC_PID $NOVNC_PID $VNC_POOL_PIDS 2>/dev/null
exit $NODE_EXIT
