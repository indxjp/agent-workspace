---
changelog: platform
section: Fixed
---

- Azure and S3 storage connections go through the outbound proxy the server's environment names
  (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`), tunnelled with `CONNECT`, instead of connecting
  directly. The egress check still runs on the endpoint's name and resolved addresses first, so a
  private, link-local or plaintext endpoint is refused with `storage_connection_endpoint_forbidden`
  and never reaches the proxy. Without a proxy, or for a `NO_PROXY` host, the connection stays
  pinned to the addresses the check saw. GCS connections already followed these variables.
