import AgentWorkspace.Authz.Tenancy

/-!
T0 — the object-key guard the scoped store runs is a filter, never a rewriter: what it accepts is
the caller's string itself, and that string has no `%`, no backslash, no control character and no
leading `/`, so the store's prefix is joined onto exactly what the caller asked for.
-/

namespace AgentWorkspace.Theorems.WellFormed.AuthzTenancy

open AgentWorkspace AgentWorkspace.Authz.Tenancy

/-- `evaluateRelativePath` returns the input unchanged or refuses it, and an accepted key contains
no `%`, no backslash and no control character, and does not start with `/`. -/
@[aw_spec (tier := T0) (doc := "docs/adr/W2-CP-03-object-key-safety.md#why-a-filter-and-not-a-canonicaliser-verification-round-2")
  (ts := "packages/core/src/storage/key-safety.ts#evaluateRelativePath")]
theorem key_guard_accepts_only_its_own_safe_input (raw : String) (allowRoot : Bool) (k : String)
    (h : keyGuard raw allowRoot = .ok k) :
    k = raw ∧ raw.toList.contains '%' = false ∧ raw.toList.contains '\\' = false ∧
      raw.toList.any isControl = false ∧ raw.toList.head? ≠ some '/' := by
  unfold keyGuard at h
  dsimp only at h
  split at h
  · cases h
  · rename_i h1
    split at h
    · cases h
    · rename_i h2
      split at h
      · cases h
      · rename_i h3
        split at h
        · cases h
        · rename_i h4
          split at h
          · cases h
          · have hk : k = raw := by
              split at h
              · split at h
                · cases h; rfl
                · cases h
              · split at h
                · cases h
                · cases h; rfl
            exact ⟨hk, by simpa using h1, by simpa using h3, by simpa using h2, by simpa using h4⟩

example : keyGuard "docs/a.md" false = .ok "docs/a.md" := rfl

end AgentWorkspace.Theorems.WellFormed.AuthzTenancy
