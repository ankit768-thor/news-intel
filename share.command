#!/bin/bash
# Share the News Intelligence Dashboard with anyone via a public link.
# Double-click this file. Keep the window open while sharing. Ctrl+C to stop.
cd "$(dirname "$0")"

# 1) Make sure the news server is running on port 8770
if ! lsof -ti:8770 >/dev/null 2>&1; then
  echo "Starting the news server…"
  python3 server.py >/tmp/news-intel-server.log 2>&1 &
  sleep 4
fi

echo ""
echo "Creating your public link (this can take a few seconds)…"
echo "Send the https://….trycloudflare.com link below to your friend."
echo "Keep this window open. Press Ctrl+C here to stop sharing."
echo ""

# 2) Open the public tunnel
./cloudflared tunnel --url http://localhost:8770
