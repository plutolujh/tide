#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 启动 HTTP 服务
echo "Starting HTTP server on :80..."
nohup python3 -m http.server 80 > /tmp/blog-http.log 2>&1 &
echo "HTTP server started (http://localhost:80)"

# 启动 sync-server (端口 3001)
echo "Starting sync-server on :3001..."
nohup node sync-server.js > /tmp/blog-sync-server.log 2>&1 &
echo "Sync server started (http://localhost:3001)"

# 启动 sync-all.js 每6小时循环
echo "Starting sync-all.js (loop every 6 hours)..."
nohup node sync-all.js 5 --loop=6 > /tmp/blog-sync.log 2>&1 &
echo "Sync script started"

echo ""
echo "Services:"
echo "  HTTP: http://localhost:80 (PID: $(pgrep -f 'http.server 80'))"
echo "  Sync Server: http://localhost:3001 (PID: $(pgrep -f 'sync-server.js'))"
echo "  Sync: every 6h (PID: $(pgrep -f 'sync-all.js'))"
echo ""
echo "Logs:"
echo "  HTTP: tail -f /tmp/blog-http.log"
echo "  Sync Server: tail -f /tmp/blog-sync-server.log"
echo "  Sync: tail -f /tmp/blog-sync.log"