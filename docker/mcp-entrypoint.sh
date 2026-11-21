#!/bin/sh
# The mcp service starts as root only long enough to make the change-log
# directory writable, then drops to LOCAL_UID. A Docker named volume is
# created root:root, including one that already exists from an earlier deploy.
# The Node process does not keep the capabilities required for this step.
set -eu
uid="${LOCAL_UID:-1000}"
gid="${LOCAL_GID:-1000}"
dir="${CHANGE_LOG_DIR:-/workspace/data/changes}"
mkdir -p "$dir"
chown -R "$uid:$gid" "$dir"
chmod 700 "$dir"
# setuid clears the permitted set. Docker already sets no-new-privileges, so
# clearing the bounding set here is unnecessary and can fail before exec.
exec setpriv --reuid="$uid" --regid="$gid" --clear-groups -- "$@"
