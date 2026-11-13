---
changelog: platform
section: Changed
---

- The CLI release pins every platform image by digest, and `aw deploy` on the `gcp-cloudrun` target
  copies only those digests into Artifact Registry. A CLI built from source carries no digests and
  still resolves image tags from the registry, and says so.
- When `cosign` is on `PATH`, `aw deploy` verifies the signature of each release image before it
  copies anything, against the identity of the `images.yml` workflow on `images-v*` tags, and says
  so. A signature that does not verify stops the deploy. `cosign` is not required: without it the
  deploy prints that the signatures were not verified and continues.
- An `AW_WEB_IMAGE`, `AW_GATEWAY_IMAGE`, `AW_RUNNER_IMAGE`, `AW_RUNTIME_IMAGE`,
  `AW_TOOL_HOST_IMAGE` or `AW_EGRESS_PROXY_IMAGE` override now prints a warning that the image is
  not one this CLI release pinned. Overrides are never signature-verified.
