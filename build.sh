#!/usr/bin/env bash
# Compile every behavior in behaviors/*.ts (except host.ts) to build/<name>.wasm
# Usage: ./build.sh            # all
#        ./build.sh patrol     # one
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build
if [ $# -gt 0 ]; then files=("behaviors/$1.ts"); else files=(behaviors/*.ts); fi
for f in "${files[@]}"; do
  name=$(basename "$f" .ts)
  [ "$name" = "host" ] && continue
  npx asc "$f" -o "build/$name.wasm" -t "build/$name.wat" \
    --runtime stub -O3 --noAssert --disable bulk-memory \
    --use abort= 2>&1
  echo "built build/$name.wasm ($(stat -c %s build/$name.wasm) bytes)"
done
