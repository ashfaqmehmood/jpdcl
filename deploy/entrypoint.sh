#!/bin/sh
set -eu

app_root="${JPDCL_APP_ROOT:-$(pwd)}"
data_root="${JPDCL_DATA_DIR:-/home/data/jpdcl}"

if [ -z "${JPDCL_WARP_PROFILE_B64:-}" ]; then
  echo "JPDCL_WARP_PROFILE_B64 is required" >&2
  exit 1
fi

install -d -m 0700 /run/jpdcl-warp
printf '%s' "$JPDCL_WARP_PROFILE_B64" | base64 -d > /run/jpdcl-warp/wgcf-profile.conf
chmod 0600 /run/jpdcl-warp/wgcf-profile.conf

if [ -n "${JPDCL_OAUTH_STATE_B64:-}" ] && [ ! -f "$data_root/oauth-state.json" ]; then
  install -d -m 0700 "$data_root"
  printf '%s' "$JPDCL_OAUTH_STATE_B64" | base64 -d > "$data_root/oauth-state.json"
  chmod 0600 "$data_root/oauth-state.json"
fi

wireproxy_bin="${JPDCL_WIREPROXY_BIN:-$app_root/wireproxy}"
"$wireproxy_bin" -c "$app_root/deploy/wireproxy.conf" -i 127.0.0.1:40002 &
wireproxy_pid=$!

cleanup() {
  kill "$wireproxy_pid" "$node_pid" 2>/dev/null || true
  wait "$wireproxy_pid" "$node_pid" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

attempt=0
until wget -q -O /dev/null http://127.0.0.1:40002/readyz; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ] || ! kill -0 "$wireproxy_pid" 2>/dev/null; then
    echo "WARP proxy did not become ready" >&2
    exit 1
  fi
  sleep 1
done

node "$app_root/dist/hosted-server.js" &
node_pid=$!

while kill -0 "$wireproxy_pid" 2>/dev/null && kill -0 "$node_pid" 2>/dev/null; do
  sleep 5
done
exit 1
