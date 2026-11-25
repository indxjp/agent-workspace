---
changelog: cli
section: Added
---

- `AW_DOCKER_HUB_MIRROR` (a registry host such as `mirror.gcr.io`) makes `create` and `deploy`
  look up a Docker Hub image's digest at that pull-through mirror first, falling back to Docker
  Hub. The generated project still pins the Docker Hub repository by digest.
