# R-02 probe fixtures — `@anthropic-ai/sandbox-runtime`

Companion to the R-02 research note (maintained privately).

Five probes, two hosts, six transcripts. Every command quoted in the note is in one of the
scripts; every output quoted in the note is copied from one of the transcripts. That claim is
mechanical and was checked mechanically: every line inside every transcript-style fenced block in
the note is `grep -F`-present in one of these files, with one documented exception (the
prescriptive `bash` block under the note's "Availability detection", which is guidance for the
Wave 7 generator rather than a quotation).

| File | What it is |
| --- | --- |
| `probe-detect.sh` | The Windows-host probe. Runs on the research workstation. Platform and Node/npm versions; `command -v` for `bwrap`/`socat`/`rg`; the `windows-install` state check (`HKLM\SOFTWARE\sandbox-runtime` registry key + `srt-sandbox` local account); a Docker fallback check; the npm registry's version, licence, engines and publish time; the repository redirect and the `v0.0.75` release date via `curl`/`gh api`; a scratch `npm install` **outside the repository**; `cli.js --version` (reproducing upstream [#207](https://github.com/anthropics/sandbox-runtime/issues/207)); `cli.js --help`; the `vendor/srt-win/*/srt-win.exe` listing; the installed tarball's licence and engines; and an **exec attempt** that shows the CLI refusing to run anything on an un-provisioned Windows host. |
| `probe-detect-win32.txt` | Raw stdout+stderr of `probe-detect.sh`, captured on the research workstation (Windows 11 Pro 10.0.26200, git-bash/MSYS2, Node v24.19.0) on 2026-09-05. |
| `probe-linux.sh` | The Linux-host wrapper. Runs `probe-linux-in-container.sh` twice inside a throwaway `node:20` container via `docker run --rm -i` — once under Docker's default profile, once with `--privileged` — and writes the two transcripts below. Installs nothing on the host: every `apt-get` and `npm install` happens inside the `--rm` container. |
| `probe-linux-in-container.sh` | The Linux probe body. **Not for direct use on a workstation** — it apt-get installs packages and npm-installs a global CLI, which is why the wrapper confines it to a container. Installs `bubblewrap`/`socat`/`ripgrep`, then exercises the sandbox: dependency check with the prerequisites absent, the A.3 detection command in both states, bare `bwrap`, the settings schema, exec with and without `enableWeakerNestedSandbox`, filesystem allow/deny, mandatory-deny, network default-deny and allowlist (repeated, plus a 20-run flake count), TLS issuer inspection against an unsandboxed control, process identity, device-node visibility, and startup latency. |
| `probe-linux-unprivileged.txt` | Raw output of that script under Docker's default profile. This is the transcript that reproduces upstream [#180](https://github.com/anthropics/sandbox-runtime/issues/180): `bwrap` cannot create a namespace, and `enableWeakerNestedSandbox: true` does not change that. |
| `probe-linux-privileged.txt` | Raw output of the same script with `--privileged`. This is the transcript behind the note's first round of Linux `verified` rows: the exec, filesystem, network, TLS, device and latency results, plus a reproduction of upstream [#417](https://github.com/anthropics/sandbox-runtime/issues/417) (`apply-seccomp: write /proc/self/uid_map: Operation not permitted`) when the flag is `false`. |
| `probe-linux-r3.sh` | Round-3 Linux wrapper. Runs `probe-linux-r3-in-container.sh` once, `--privileged`, in the same `node:20` image. A supplement to `probe-linux.sh`, not a replacement. |
| `probe-linux-r3-in-container.sh` | The round-3 probe body. **Not for direct use on a workstation.** Ten sections, each one a row the previous revision of the note graded without running the command that would settle it: the `uname` comparison behind `isolation`, a **non-empty** `denyWrite` inside an `allowWrite` region, the proxy environment handed to the sandboxed process, three independent 20-request flake counts, a 100-second command against a session limit, `deniedDomains` deny-first, the `*.` wildcard, the `:port` suffix, bracketed vs unbracketed IPv6 entries, and all three Unix-socket settings against a live container-side socket. Its network sections retry past the proxy-startup race and print the attempt count, so the retry is visible in the transcript. |
| `probe-linux-r3-privileged.txt` | Raw output of that script. |
| `probe-ubuntu2404.sh` | The Ubuntu 24.04 counterfactual, run instead of predicted. Same probe shape in an `ubuntu:24.04` image, both privilege modes, with Node 20.20.2 installed from nodejs.org rather than Ubuntu's own v18 so the run cannot be dismissed as an `engines` mismatch. It exists because `bwrap` 0.9.0 — the binary upstream [#428](https://github.com/anthropics/sandbox-runtime/issues/428) names — lives in the image, not the host kernel. |
| `probe-ubuntu2404.txt` | Raw output of that script, both modes. |
| `probe-macos-route.sh` | The macOS-route checks: `sandbox-exec`, five local hypervisors, `docker buildx ls`, and the `kernel.apparmor_restrict_unprivileged_userns` read on two images. Read-only; it installs nothing and starts no hypervisor. It exists because the note's largest declared gap must be checkable like every other claim in it. |
| `probe-macos-route.txt` | Raw output of that script. |

Each transcript begins with a generated header naming the exact `docker run` command, the host,
and the `docker info` output that produced it.

## Package named (module-graph gate)

No script here imports `@anthropic-ai/sandbox-runtime` from inside this directory.
`probe-detect.sh` installs it into a `mktemp -d` scratch directory **outside the repository**
and requires it from there with a relative specifier resolved against that scratch `cwd`.
`probe-linux-in-container.sh`, `probe-linux-r3-in-container.sh` and the body
`probe-ubuntu2404.sh` pipes into its container all install it globally **inside a throwaway
container**. `probe-macos-route.sh` does not install it at all. No file under this directory has
a bare or relative import of the package, and nothing here needs a `node_modules` inside the repo
to resolve. The two `.js` snippets `probe-linux-r3-in-container.sh` writes for its Unix-socket
probe are heredocs materialised at `/tmp/work/` inside the container; they import Node's own
`net` and nothing else, and no `.js` file is committed under this directory.

## Reproducing

```bash
bash probe-detect.sh > probe-detect-win32.txt 2>&1     # Windows host
bash probe-linux.sh                                    # writes both probe-linux-{un,}privileged.txt
bash probe-linux-r3.sh                                 # writes probe-linux-r3-privileged.txt
bash probe-ubuntu2404.sh                               # writes probe-ubuntu2404.txt
bash probe-macos-route.sh                              # writes probe-macos-route.txt
```

**One of these transcripts does not reproduce, by design, and the note says so.** The
"PROXY-STARTUP FLAKE RATE" counts vary from 1/20 to 10/20 successes across runs of the same
fixture on the same host. Re-running `probe-linux-r3.sh` and getting different counts is the
expected result, not a discrepancy; it is why the note grades that *rate* `unknown` while grading
the failure's *existence* `verified`. Every network section in `probe-linux-r3-in-container.sh`
retries past that race and prints how many attempts it consumed, so a re-run's policy answers
(the 200s and 403s) should match even when the attempt counts do not.

`probe-detect.sh` requires `node`, `npm`, network access to the npm registry, and — for the
GitHub section — `curl` and an authenticated `gh`; each of those sections prints its own
"unavailable" line rather than aborting if a tool is missing. `probe-linux.sh` requires Docker
with a **Linux** engine: `docker info` must report `OSType: linux`. On Windows that is Docker
Desktop's WSL2 VM, which is what produced the committed transcripts — see the header line in
each one.

On a real Linux or macOS host, `probe-detect.sh`'s prerequisite and Windows-state checks will
report differently by design. That is the point of running on more than one OS before Wave 7
trusts a single-platform result.

## Provenance

Everything in all six transcripts is `verified` in the sense the note's Decisions table uses:
executed by the committed script, output captured verbatim, no summarization step in between.
The note quotes these files by copying from them; where a quotation is abridged, the note says
so and names the section the full text is in.

The one thing that is deliberately **not** captured verbatim is `reg query`'s failure message in
`probe-detect.sh`: it prints in the OS display language and rendered as mojibake under this
machine's console code page, so the script sends it to `/dev/null` and reports the exit code
instead. The exit code is the portable signal and is what the note cites.

This is a twice-repaired revision.

The first repair added `probe-linux.sh` and its two transcripts, after the first revision
committed only `probe-detect.sh` and `probe-detect-win32.txt` while attributing to them four
things that script did not run: the `--help` listing, the `vendor/srt-win` presence check, the
`npm view` licence/engines lookup, and the release date. The script now runs all four.

The second repair — round 3 — added the last three scripts, for the same class of defect one
level up: the note had begun grading rows `verified` on commands *no* script ran. `denyWrite`
precedence, the `uname` comparison behind `isolation`, the proxy port, the Ubuntu 24.04
counterfactual and the whole macOS-route section were prose. They are transcripts now. The one
claim that could not survive being re-run — the proxy-startup failure *rate* — was moved to
`unknown` rather than re-measured into a new number.

Retrieved 2026-09-05 against `@anthropic-ai/sandbox-runtime@0.0.75`. Host A: Node v24.19.0,
Windows 11 Pro 10.0.26200. Host B: Node v20.20.2, Debian GNU/Linux 12 (bookworm) on kernel
6.18.35.2-microsoft-standard-WSL2, under Docker 29.7.2 (`OSType=linux`).
