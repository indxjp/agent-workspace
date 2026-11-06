#!/bin/sh
# The commands that write examples/crm, run from an empty directory. What they write is kept
# unedited, apart from the files benchmark.ts counts as handwritten: `node tests/apps/regenerate.mjs
# --check crm` runs them again and compares.
set -eu

npm create @indx-workspace crm -- --template crm --yes
cd crm
npx aw generate resource company name:text domain:text
npx aw generate resource contact name:text email:text 'company:ref(company)?' owner:person
npx aw generate resource deal name:text 'amount:money(JPY)' 'stage:enum(lead,qualified,proposal,won,lost)' owner:person --board stage
npx aw generate recipe enrich-contact --on resource:contact.created
npx aw generate agent sales-assistant --tools contact,company,deal
