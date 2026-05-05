#!/bin/bash
cd "$(dirname "$0")"
nohup python3 -m http.server 8080 > server.log 2>&1 &
echo "Server started at http://localhost:8080 (PID: $!)"
