#!/bin/sh
# Usage: ./deploy.sh [major|minor|patch] "commit message"
# Bumps version, rebuilds frontend, restarts uvicorn, purges CF cache, commits and pushes.

set -e

BUMP=${1:-patch}
MSG=${2:-""}

# Bump version
cd /workspace
bash bump_version.sh "$BUMP"
VERSION=$(cat VERSION)

# Rebuild frontend
cd /workspace/frontend
npm run build

# Restart uvicorn
for pid in $(ls /proc | grep '^[0-9]*$'); do
  cmd=$(cat /proc/$pid/cmdline 2>/dev/null | tr '\0' ' ')
  if echo "$cmd" | grep -q "uvicorn app:app"; then kill $pid 2>/dev/null; fi
done
sleep 5

# Verify
cd /workspace/server
python3 -c "import urllib.request; print(urllib.request.urlopen('http://localhost:8000/version').read().decode())"

# Purge CF cache
python3 -c "
import urllib.request, json
req = urllib.request.Request(
  'http://172.20.0.1:7000/cf/purge',
  data=json.dumps({'prefixes':['terrrence.hirudyne.net']}).encode(),
  headers={'X-Gateway-Token': open('/workspace/.gateway-token').read().strip(), 'Content-Type': 'application/json'},
  method='POST'
)
print(urllib.request.urlopen(req).read())
"

# Commit and push
cd /workspace
if [ -n "$MSG" ]; then
  git add -A && git commit -m "v${VERSION} - ${MSG}" && git push origin main
else
  echo "No commit message provided - skipping commit."
fi
