import Lake
open Lake DSL

/-!
The Agent Workspace formal specification. Dependencies are pinned by commit; the chosen
revisions and their licences are recorded in docs/adr/0062 and docs/dependency-policy.md.
-/

package AgentWorkspace where
  leanOptions := #[⟨`autoImplicit, false⟩, ⟨`relaxedAutoImplicit, false⟩]

require batteries from git
  "https://github.com/leanprover-community/batteries" @ "f2effa3d803fda822b1f97b806c47cf2adfbcbc2"

require plausible from git
  "https://github.com/leanprover-community/plausible" @ "118aa17ee84656b8bd727fef7c458ee8c833385c"

@[default_target]
lean_lib AgentWorkspace

lean_lib Tools

lean_lib Vectors

/-- `generated/ErSnapshot.lean`: the ER snapshot pins `pnpm formal:generate` writes. -/
lean_lib Generated where
  srcDir := "generated"
  roots := #[`ErSnapshot]

/-- Writes the catalogue of `@[spec]`-tagged declarations as JSON. -/
lean_exe catalogue where
  root := `Tools.Catalogue
  supportInterpreter := true

/-- Fails when any declaration depends on an axiom outside the allowed three. -/
lean_exe axioms where
  root := `Tools.Axioms
  supportInterpreter := true

/-- Fails when a module imports against the documented layer direction. -/
lean_exe imports where
  root := `Tools.Imports
  supportInterpreter := true

/-- Writes the differential test vectors under `vectors/`. -/
lean_exe vectors where
  root := `Vectors.Main
  supportInterpreter := true
