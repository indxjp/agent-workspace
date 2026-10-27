# Gallery pages

Two standalone pages and a plan that accompany the [enterprise use-case gallery](../site/tutorials/index.mdx)
and its code in [`tests/gallery/`](../../../tests/gallery/README.md). Open them in a browser; they
need nothing but the Google Fonts stylesheet (and render with system fonts without it).

| Page                                                             | What it is                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`enterprise-agent-gallery.html`](enterprise-agent-gallery.html) | The gallery as a showcase, Japanese first with an English toggle: the ten use cases, why Japanese enterprises want each, its architecture, a code sketch, the verified benchmark, what building them found, and the cross-cutting gaps ranked by how many use cases they block. |
| [`verification-workflow.html`](verification-workflow.html)       | How each use case was implemented and verified: the seven-stage pipeline, the evidence tiers, how the work was split, the status board and the findings.                                                                                                                        |
| [`path-to-100.md`](path-to-100.md)                               | The plan that takes the ten tutorials to 100: today's audited scores, the score after each phase, and every unit (tracker #1273) with its steps, tests, acceptance criteria and score effect.                                                                                   |

Both are snapshots of the state on 2026-10-04. The tutorials' "Where the SDK stands" tables are
generated from the benchmarks and checked by `tests/gallery/benchmark.test.ts`; these pages are
not, so when a probe flips, the tutorials are the source of truth.
