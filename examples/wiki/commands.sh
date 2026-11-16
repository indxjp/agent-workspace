#!/bin/sh
# The commands that write examples/wiki, run from an empty directory. What they write is kept
# unedited: `node tests/apps/regenerate.mjs --check wiki` runs them again and compares.
set -eu

npm create @indx-workspace wiki -- --template wiki --yes
cd wiki
npx aw generate agent writer --tools page
