---
changelog: platform
section: Changed
---

- A new sign-in session no longer carries the unused `role` claim; the role has always been read
  from the membership on every request. Sessions from earlier releases keep working until they
  expire. 0.6.13 already accepts a session without the claim, so a rollback to 0.6.13 is safe; a
  rollback to 0.6.12 or earlier signs people out once.
