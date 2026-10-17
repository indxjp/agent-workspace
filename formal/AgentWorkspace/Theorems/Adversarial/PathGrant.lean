import AgentWorkspace.Authz.PathGrant

/-!
# T3 — a read-only grant cannot be written, through any spelling (ENG-04, #303)

*"Every path the adapter allows to be written normalises to a location outside every read-only
grant, including through `..` and symlink escapes."*

The three theorems below are that sentence taken apart:

1. an allowed write's path lies outside every read-only grant — the claim itself;
2. `..` is *resolved* rather than matched, so no spelling of a covered path is allowed;
3. containment is by segment, so a name that merely starts with a grant is not treated as
   inside it — the direction where a prefix comparison silently allows a write.

A symlink is not resolved here and must not be: resolving one needs a filesystem, and a
filesystem answer is only true at the instant it is read. What is covered is the recorded
*target*, which arrives as a string and goes through the same normalisation as any other path.
-/

namespace AgentWorkspace.Theorems.Adversarial.PathGrant

open AgentWorkspace.Authz.PathGrant

/-- An allowed write lands outside every read-only grant. The claim itself. -/
@[aw_spec (tier := T3) (doc := "docs/sdk/site/building/extending-the-platform.mdx#file-grants")
  (ts := "packages/engine/src/path-grant.ts#writeGrantVerdict")]
theorem allowed_write_is_outside_every_read_only_grant (protectedDirectory : Option String)
    (grants : List Grant) (candidate : String) (segments : List String)
    (h : writeGrantVerdict protectedDirectory grants candidate = .ok segments) :
    ∀ g ∈ grants, g.readOnly = true → covers g segments = false := by
  intro g hg hro
  unfold writeGrantVerdict at h
  cases hn : normaliseGrantPath protectedDirectory candidate with
  | refused _ => simp [hn] at h
  | ok normalised =>
    rw [hn] at h
    by_cases hany : grants.any (fun g => g.readOnly && covers g normalised)
    · simp [hany] at h
    · simp [hany] at h
      subst h
      have hnot : ¬(g.readOnly && covers g normalised) = true :=
        fun hcov => hany (List.any_eq_true.mpr ⟨g, hg, hcov⟩)
      simpa [hro] using hnot

/-- Every spelling of a path inside a read-only directory grant is refused a write.

Written as a table of the shapes an escape is actually written in, because the property that
matters is not "one of them is refused" but "the redundant spellings all normalise to the same
thing and none of them gets through". -/
@[aw_spec (tier := T3) (ts := "packages/engine/src/path-grant.ts#normaliseGrantPath")]
theorem every_spelling_of_a_covered_path_is_refused :
    let grants : List Grant := [{ directory := true, segments := ["docs"], readOnly := true }]
    (writeGrantVerdict none grants "docs/spec.md").isOk = false ∧
    (writeGrantVerdict none grants "docs/./spec.md").isOk = false ∧
    (writeGrantVerdict none grants "notes/../docs/spec.md").isOk = false ∧
    (writeGrantVerdict none grants "docs/nested/../spec.md").isOk = false := by decide

/-- A `..` that climbs above the workspace root is refused rather than clamped.

Clamping — treating `../../etc/passwd` as `etc/passwd` — is the repair a careless normaliser
makes, and it turns an escape into a write inside the sandbox at a path nobody granted. -/
@[aw_spec (tier := T3) (ts := "packages/engine/src/path-grant.ts#normaliseGrantPath")]
theorem climbing_above_the_root_is_refused :
    normaliseGrantPath none "../etc/passwd" = .refused .escapesRoot ∧
    normaliseGrantPath none "docs/../../etc/passwd" = .refused .escapesRoot ∧
    normaliseGrantPath none "a/../.." = .refused .escapesRoot := by decide

/-- An absolute path — POSIX or Windows — is refused rather than read as a relative one.

The Windows arms matter because a grant composed on one platform is enforced on another: `C:\x`
read as a relative path is one oddly-named file *inside* the sandbox, which is not what its
author meant. -/
@[aw_spec (tier := T3) (ts := "packages/engine/src/path-grant.ts#normaliseGrantPath")]
theorem absolute_paths_are_refused :
    normaliseGrantPath none "/etc/passwd" = .refused .absolute ∧
    normaliseGrantPath none "C:/Windows" = .refused .absolute ∧
    normaliseGrantPath none "\\\\server\\share" = .refused .illegalCharacter := by decide

/-- Containment is by segment: a sibling whose name merely starts with a grant is writable.

The positive witness, and the direction that matters — a prefix comparison the other way round
would treat `docs` as covering nothing and allow a write into it. -/
@[aw_spec (tier := T3) (ts := "packages/engine/src/path-grant.ts#isWithin")]
theorem a_name_that_starts_with_a_grant_is_not_inside_it :
    let grants : List Grant := [{ directory := true, segments := ["docs"], readOnly := true }]
    writeGrantVerdict none grants "docs-private/secret.md" = .ok ["docs-private", "secret.md"] ∧
    writeGrantVerdict none grants "scratch/out.md" = .ok ["scratch", "out.md"] := by decide

/-- A file grant protects exactly itself, and a directory grant protects its descendants. -/
@[aw_spec (tier := T3) (ts := "packages/engine/src/path-grant.ts#writeGrantVerdict")]
theorem a_file_grant_does_not_cover_its_siblings :
    let grants : List Grant :=
      [{ directory := false, segments := ["config", "app.yaml"], readOnly := true }]
    (writeGrantVerdict none grants "config/app.yaml").isOk = false ∧
    writeGrantVerdict none grants "config/other.yaml" = .ok ["config", "other.yaml"] := by decide

/-- A grant list with one unreadable entry is refused whole, never narrowed by dropping it. -/
@[aw_spec (tier := T3) (ts := "packages/engine/src/path-grant.ts#normaliseGrants")]
theorem an_unreadable_grant_refuses_the_whole_list :
    normaliseGrants none [(true, "docs", true), (false, "../escape.md", true)] = none := by decide

end AgentWorkspace.Theorems.Adversarial.PathGrant
