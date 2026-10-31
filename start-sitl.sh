#!/usr/bin/env bash
set -euo pipefail

COLLEGE_LAT=13.012532113424296
COLLEGE_LON=77.70430505764747
ALTITUDE=900
HEADING=0

ARDUPILOT_DIR="$HOME/ardupilot"
ARDUCOPTER="$ARDUPILOT_DIR/build/sitl/bin/arducopter"

echo "============================================"
echo "Starting ArduCopter SITL at college location"
echo "  Vehicle : ArduCopter (quadcopter)"
echo "  Lat: $COLLEGE_LAT"
echo "  Lon: $COLLEGE_LON"
echo "  Alt: ${ALTITUDE}m"
echo "  Hdg: ${HEADING}°"
echo "  Backend connects via TCP:5760 or UDP:14550"
echo "  (MAVProxy forwards TCP:5760 -> UDP:14550)"
echo "============================================"

if [ ! -f "$ARDUCOPTER" ]; then
  echo "ERROR: arducopter not found at $ARDUCOPTER"
  echo "Run sim_vehicle.py first to build"
  exit 1
fi

MAVPROXY="$HOME/.local/bin/mavproxy.py"

echo "[1] Starting ArduCopter SITL..."
"$ARDUCOPTER" \
  --model quad \
  --speedup 1 \
  --synthetic-clock \
  -I0 \
  --home "$COLLEGE_LAT,$COLLEGE_LON,$ALTITUDE,$HEADING" \
  &>/tmp/arducopter.log &
ARDUCOPTER_PID=$!
echo "  PID=$ARDUCOPTER_PID"

echo "[2] Waiting for TCP:5760..."
for i in $(seq 1 30); do
  if ss -tlnp 2>/dev/null | grep -q :5760; then
    echo "  TCP:5760 ready after ${i}s"
    break
  fi
  sleep 1
done

echo "[3] Starting MAVProxy (TCP:5760 -> UDP:14550)..."
if [ -f "$MAVPROXY" ]; then
  tail -f /dev/null | "$MAVPROXY" \
    --master tcp:127.0.0.1:5760 \
    --out udp:127.0.0.1:14550 \
    &>/tmp/mavproxy.log &
  MAVPROXY_PID=$!
  echo "  PID=$MAVPROXY_PID"
else
  echo "  WARNING: mavproxy.py not found — UDP:14550 unavailable (use TCP:5760 only)"
  MAVPROXY_PID=""
fi

echo ""
echo "ArduCopter SITL running on TCP:5760 / UDP:14550 (SITL PID=$ARDUCOPTER_PID). Click CONNECT to connect."

cleanup() {
  echo ""
  echo "Shutting down..."
  if [ -n "${MAVPROXY_PID:-}" ]; then
    kill "$MAVPROXY_PID" 2>/dev/null || true
    wait "$MAVPROXY_PID" 2>/dev/null || true
  fi
  kill "$ARDUCOPTER_PID" 2>/dev/null || true
  wait "$ARDUCOPTER_PID" 2>/dev/null || true
  echo "Stopped."
}
trap cleanup EXIT INT TERM

wait
cleanup
