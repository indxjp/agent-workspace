# The engine runtime image plus the busybox applets the isolation checks run inside a sandbox
# (`wget -Y`, `nc`, `nslookup`). The applets sit last on PATH, so every tool the image has keeps
# winning; the entrypoint, user and filesystem of the image are untouched.
ARG RUNTIME_IMAGE
# The musl build is static: the default (glibc) busybox needs a newer glibc than the engine image's.
FROM busybox:1.37.0-musl@sha256:5cec3fc171c87218698e85a52af7087de727372aae264a787b8112901a5b0092 AS tools
RUN mkdir /out && cp /bin/busybox /out/busybox \
  && for applet in wget nc nslookup; do ln -s busybox "/out/$applet"; done

FROM ${RUNTIME_IMAGE}
COPY --from=tools /out /opt/probe
ENV PATH=$PATH:/opt/probe
