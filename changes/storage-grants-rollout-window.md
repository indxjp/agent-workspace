---
changelog: platform
section: Fixed
---

- Pointing `local` back at an older agent version binds the storage connections that version was
  deployed with, by connection id. After a connection was deleted and recreated under the same
  name, the move used to bind the new connection to the old version, so the new connection could
  not be deleted although the version could not run.
- Migration 0093 gives a version materialised during the upgrade window (by a server older than
  per-version storage grants) the grants its agent holds, so it no longer fails closed with
  `run_storage_grant_unavailable`. It never binds a connection created after the version.
- A run lists each granted storage-connection folder once per launch instead of twice; the input
  archive and the `/run` body share one listing.
