#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 启动 HTTP 服务
echo "Starting HTTP server on :8888..."
nohup python3 -m http.server 8888 > /tmp/blog-http.log 2>&1 &
echo "HTTP server started (http://localhost:8888)"

# 启动 sync-hn.js 每6小时循环
echo "Starting sync-hn.js (loop every 6 hours)..."
nohup node sync-hn.js 5 --loop=6 > /tmp/blog-sync.log 2>&1 &
echo "Sync script started"

echo ""
echo "Services:"
echo "  HTTP: http://localhost:8888 (PID: $(pgrep -f 'http.server 8888'))"
echo "  Sync: every 6h (PID: $(pgrep -f 'sync-hn.js'))"
echo ""
echo "Logs:"
echo "  HTTP: tail -f /tmp/blog-http.log"
echo "  Sync: tail -f /tmp/blog-sync.log"