#!/bin/sh
# The container's entry point. A mounted volume arrives owned by root, so this
# runs as root just long enough to hand the state directory to the unprivileged
# user, then runs the server as that user. It never creates the directory: an
# unmounted volume must fail at start (the server refuses a state directory it
# cannot write), not count the day on the disposable root disk.
set -e
if [ -n "$WORKSHOP_STATE_DIR" ] && [ -d "$WORKSHOP_STATE_DIR" ]; then chown node:node "$WORKSHOP_STATE_DIR"; fi
exec runuser -u node -- "$@"
