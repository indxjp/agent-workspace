#!/bin/sh
# The commands that write examples/team-chat, run from an empty directory. What they write is kept
# unedited: `node tests/apps/regenerate.mjs --check team-chat` runs them again and compares.
set -eu

npm create @indx-workspace team-chat -- --template chat --yes
cd team-chat
npx aw generate resource channel name:text 'kind:enum(public,private,dm)'
# A message starts a thread or replies in one, and has files only when someone attaches them, so
# `thread_root` and `attachments` are optional (`?`, quoted so sh does not glob it).
npx aw generate resource message 'channel:ref(channel)' body:richText 'attachments:files?' 'thread_root:ref(message)?'
npx aw generate channel message
npx aw generate agent helper --tools channel,message
npx aw generate recipe on-mention --on resource:message.created
