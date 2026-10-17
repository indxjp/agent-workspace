# W1-INF-01 — The runner's entry point is named in the Dockerfiles because no source file starts it

Status: accepted
Date: 2026-09-03
Decided by: W1-INF-01 (Infra)
Scope: `Dockerfile` (`runner` target), `runtime.Dockerfile`; owed back to whoever owns
`apps/runner/src/index.ts`

## Context

`apps/runner/package.json` declares `"start": "node dist/index.js"`, and
`apps/runner/src/index.ts` is still the file W0-INF-01 landed in the bootstrap wave:

> Placeholder module. The real contents (agent.ts, sessions.ts, runtime.ts, server.ts) land in
> later waves; an empty package is the correct state at this point.

It exports one constant and exits. W1-RN-02 subsequently landed `server.ts` — including
`startRunnerServer()`, which reads `HOST` and `PORT` and returns a listening server — and did not
change `index.ts`, because its ownership globs are `apps/runner/src/{server,runtime}.ts`.

So `node dist/index.js` in a container starts nothing and exits 0, and a `CMD` pointing at it would
produce a `runner` service that restarts forever without ever listening.

## Decision

**Both Dockerfiles name the entry point directly:**

```
CMD ["node", "--input-type=module", "-e", "import { startRunnerServer } from '…/dist/server.js'; …"]
```

rather than `node dist/index.js` or `pnpm start`. A container's command belongs to the file that
builds the container, so this is inside this task's ownership; editing `apps/runner/src/index.ts`
to re-export `server.ts` is not.

It is a smell and it is written down as one. The correct end state is a two-line `index.ts` that
imports `startRunnerServer` and calls it, `package.json`'s `start` script pointing at it, and both
`CMD`s reduced to `["node", "dist/index.js"]`. That is a small change, in one task's file, and the
first task to touch `apps/runner/src/index.ts` should make it.

## Alternatives rejected

* **Edit `apps/runner/src/index.ts`.** One line, obviously right, and outside the declared `Owns`
  boundary (ADR-0018). The wave's brief for this task is explicit: *"Do not fix other tasks' code;
  report conflicts instead."* An integrator who edits six files to make its own acceptance pass
  destroys the wave's signal about what those six tasks actually delivered.
* **`CMD ["pnpm", "start"]`.** Same problem one level of indirection away — the script points at
  the same placeholder — and it keeps `pnpm` and `corepack` in the runtime layers of a sandbox
  image for no other reason.
* **A shell script entry point committed at the repository root.** A new file, and new files are
  inside this task's ownership only if the glob names them; `entrypoint.sh` is not in the `Owns`
  line, and widening the line to smuggle in a file is worse than an inline `CMD`.

## Honest downside

**The entry point is now written in two places and neither is TypeScript.** The import path
`/srv/apps/runner/dist/server.js` is a string in two Dockerfiles; if the emit layout changes, the
compiler will not notice and the container will fail at start with a module-resolution error. The
healthcheck catches it within a minute, and "catches it" is not the same as "prevents it".

**`pnpm start` is now wrong for this package** — it will stay wrong until `index.ts` is fixed, and a
developer who runs it locally gets a process that exits silently with status 0. That is exactly the
kind of quiet nothing this programme keeps finding, and the only defence in this task's power is
this record.
