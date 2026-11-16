#!/bin/sh
# The commands that write examples/service-desk, run from an empty directory. What they write is
# kept unedited: `node tests/apps/regenerate.mjs --check service-desk` runs them again and compares.
set -eu

npm create @indx-workspace service-desk -- --template desk --yes
cd service-desk
npx aw generate resource ticket title:text description:richText 'status:enum(new,in_progress,on_hold,resolved,closed)' 'priority:enum(p1,p2,p3,p4)' requester:person assignee:person --board status
npx aw generate resource kb_article title:text body:richText tags:tags
npx aw generate resource ticket_comment 'ticket:ref(ticket)' body:richText internal:bool
npx aw generate recipe triage-incident --on resource:ticket.created
npx aw generate recipe sla-sweep --on 'schedule:*/5 * * * *'
npx aw generate agent triage --tools ticket,kb_article
npx aw generate agent closer --tools ticket
