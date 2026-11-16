#!/bin/sh
# The commands that write examples/store, the Agent Store, run from an empty directory. What they
# write is kept unedited, apart from the files benchmark.ts counts as handwritten:
# `node tests/apps/regenerate.mjs --check store` runs them again and compares. The catalog
# (`catalog/`) and the store's own screens are handwritten; the store keeps no data of its own and
# reaches the platform only through its public API and the SDK.
set -eu

npm create @indx-workspace store -- --template portal --yes
cd store
npx aw generate page platform --kind custom
npx aw generate page privacy --kind custom
npx aw generate page contact --kind custom
