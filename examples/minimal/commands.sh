#!/bin/sh
# The commands that write examples/minimal, run from an empty directory. What they write is kept
# unedited: `node tests/apps/regenerate.mjs --check minimal` runs them again and compares.
set -eu

npm create @indx-workspace minimal -- --template portal --yes
cd minimal
npx aw generate resource note title:text body:richText
npx aw generate agent helper --tools note
