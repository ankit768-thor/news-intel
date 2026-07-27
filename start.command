#!/bin/bash
# Open the News Intelligence Dashboard.
# The server now runs automatically in the background (installed login agent),
# so this just opens it in your browser. If it's somehow not running, it starts it.
cd "$(dirname "$0")"
if ! curl -s -o /dev/null --max-time 3 http://localhost:8770/; then
  echo "Server not responding — starting it…"
  python3 server.py >/tmp/news-intel-server.log 2>&1 &
  sleep 4
fi
open "http://localhost:8770"
