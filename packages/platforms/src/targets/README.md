Each platform target is one directory here, `<platform-id>/`, plus one line in `../registry.ts`. See the package README.

Each target handles every tool kind in its own `switch (tool.kind)`, with no `default:` branch: a new kind then fails the typecheck in every target until each says what it does with it (`../tool-kind-switches.test.ts`).
