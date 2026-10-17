# The sandbox image of the isolation lanes. The drivers' isolation flags do not depend on what the
# image contains, so a minimal busybox stands in for an engine image: it has `id`, `wget`, `sh` and
# an HTTP server for the stub gateway and decoy, and `sleep` keeps the sandbox alive for `exec`.
FROM busybox:1.37.0@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e
RUN mkdir /www && echo isolation-probe > /www/index.html
CMD ["sleep", "3600"]
