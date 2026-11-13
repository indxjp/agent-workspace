---
changelog: platform
section: Changed
---

- Connecting storage now saves and then tests the connection at once with its stored key ("Save
  and test"), the same test as the Test button on Storage. The page says "Saved and connected", or
  what failed (credential, location, reachability, or an allowed folder with no files) with a link
  to edit the connection. The connection stays saved either way (UX-07 in #2086).
