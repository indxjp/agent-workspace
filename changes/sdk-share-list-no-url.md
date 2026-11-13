---
changelog: sdk
section: Changed
---

- `shares.list()` items no longer carry `url`. Keep the `url` that `shares.publish()` returns: it
  is the only time a public link is shown. An older SDK refuses a list that holds a public share,
  because its schema still required `url` on one; upgrade the SDK with the server.
