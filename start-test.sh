#!/bin/bash
# Start test RTSP streams for end-to-end camera testing

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$SCRIPT_DIR/backend"

cleanup() {
  echo "Stopping all services..."
  kill $MEDIAMTX_PID $LIVE_PID $THERMAL_PID 2>/dev/null
  wait $MEDIAMTX_PID $LIVE_PID $THERMAL_PID 2>/dev/null
  echo "Done."
  exit 0
}
trap cleanup SIGINT SIGTERM

echo "=== Starting MediaMTX RTSP Server ==="
"$BACKEND/mediamtx" "$BACKEND/mediamtx.yml" > /dev/null 2>&1 &
MEDIAMTX_PID=$!
sleep 1
echo "MediaMTX running on rtsp://localhost:8554 (PID: $MEDIAMTX_PID)"

echo ""
echo "=== Starting Live Camera stream (test pattern) ==="
"$BACKEND/ffmpeg" -hide_banner -loglevel error -re -f lavfi -i "testsrc2=size=640x480:rate=15" \
  -vcodec libx264 -preset ultrafast -tune zerolatency -f rtsp rtsp://localhost:8554/live &
LIVE_PID=$!
echo "Publishing to rtsp://localhost:8554/live (PID: $LIVE_PID)"

echo ""
echo "=== Starting Thermal Camera stream (orange gradient) ==="
"$BACKEND/ffmpeg" -hide_banner -loglevel error -re -f lavfi -i "color=c=#8B0000:s=640x480:r=15" \
  -f lavfi -i "gradients=s=640x480:r=15" \
  -filter_complex "[0]format=yuv420p[bg];[1]format=gray,colorchannelmixer=rr=1:gg=0.4:bb=0[overlay];[bg][overlay]overlay" \
  -vcodec libx264 -preset ultrafast -tune zerolatency -f rtsp rtsp://localhost:8554/thermal &
THERMAL_PID=$!
echo "Publishing to rtsp://localhost:8554/thermal (PID: $THERMAL_PID)"

echo ""
echo "============================================"
echo "  All test streams are running!"
echo ""
echo "  Open the app at http://localhost:5173"
echo ""
echo "  Click CAMERA button (green, in top bar)"
echo "  Enter:"
echo "    Live:    rtsp://localhost:8554/live"
echo "    Thermal: rtsp://localhost:8554/thermal"
echo ""
echo "  Press Ctrl+C to stop everything"
echo "============================================"

wait
