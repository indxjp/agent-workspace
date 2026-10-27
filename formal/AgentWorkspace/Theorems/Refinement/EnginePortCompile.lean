import AgentWorkspace.Behaviour.EnginePort

/-!
# T4 — the extraction preserves behaviour (ENG-04, #303)

ENG-04's defining constraint is *"the Claude Agent SDK is the first adapter behind that port,
extracted **without behaviour change**"*. This is the formal half of it.

`compileCurrent` is `packages/core/src/config.ts`'s `compileRunRequest` as it stood before the
unit; `compileTarget` is the adapter's `compile`, which parses the engine arm, consults the
declared capabilities, and then computes the same environment. The refinement is stated as an
**equality of outputs wherever both succeed**, because the computation did not change — only its
address did.

The three places the target is *stricter* are stated as separate theorems rather than folded
into the equality, because they are the unit's only intended behaviour changes and each turns a
late failure into a named refusal:

* a policy arm the adapter cannot read is `engine_policy_invalid`, where the old path threw a
  `ZodError` at the runner's HTTP boundary;
* a fork on an engine whose capabilities say `fork: false` is `engine_capability_unsupported`,
  where the old path compiled a request the SDK then ignored;
* a credential-shaped variable holding something other than the run token is
  `engine_credential_refused`, where the old path let it through. That one is an *addition* to
  A.11's `ANTHROPIC_API_KEY` refusal, never a replacement — `todays_composed_environment_is_accepted`
  in `Theorems/Adversarial/EngineSandboxEnv.lean` is the witness that no run the platform
  composes today is caught by it.
-/

namespace AgentWorkspace.Theorems.Refinement.EnginePortCompile

open AgentWorkspace.Behaviour.EnginePort AgentWorkspace.Behaviour.SandboxEnv

/-- The current compile's output, whenever it has one, is the assembled environment.

The assembly is the part that had to survive the move: the request's own entries with the four
derived ones appended last, so a caller cannot set a derived name for itself. -/
@[aw_spec (tier := T4) (doc := "docs/formal/units/run-compose.md#theorems-and-vectors")
  (ts := "packages/engine-claude-agent-sdk/src/compile.ts#compileRunRequest")]
theorem current_compile_yields_the_assembled_environment (request : Request)
    (projectKey configDir : String) (env : List (String × String))
    (h : compileCurrent request projectKey configDir = some env) :
    env = assembledEnv request projectKey configDir := by
  unfold compileCurrent AgentWorkspace.Behaviour.RunCompose.compiledEnvironment at h
  dsimp only at h
  split at h
  · exact absurd h (by simp)
  · exact (Option.some.inj h).symm

/-- The target compile's output, whenever it has one, is the same assembled environment. -/
@[aw_spec (tier := T4) (ts := "packages/engine-claude-agent-sdk/src/engine.ts#createClaudeAgentSdkEngine")]
theorem target_compile_yields_the_assembled_environment (capabilities : Capabilities)
    (request : Request) (projectKey configDir : String) (env : List (String × String))
    (h : compileTarget capabilities request projectKey configDir = .compiled env) :
    env = assembledEnv request projectKey configDir := by
  unfold compileTarget at h
  split at h
  · exact absurd h (by simp)
  · split at h
    · split at h
      · dsimp only at h
        split at h
        · exact (CompileResult.compiled.inj h).symm
        · exact absurd h (by simp)
      · exact absurd h (by simp)
    · dsimp only at h
      split at h
      · exact (CompileResult.compiled.inj h).symm
      · exact absurd h (by simp)

/-- **The refinement.** Wherever both compiles produce an environment, they produce the same one.

That is what "extracted without behaviour change" means for this unit, and it is an equality
rather than a simulation because the computation is the same function at a new address. -/
@[aw_spec (tier := T4) (doc := "docs/formal/units/run-compose.md#theorems-and-vectors")
  (ts := "packages/engine-claude-agent-sdk/src/compile.ts#compileRunRequest")
  (ts := "packages/engine-claude-agent-sdk/src/engine.ts#createClaudeAgentSdkEngine")]
theorem target_and_current_agree (capabilities : Capabilities) (request : Request)
    (projectKey configDir : String) (envTarget envCurrent : List (String × String))
    (hTarget : compileTarget capabilities request projectKey configDir = .compiled envTarget)
    (hCurrent : compileCurrent request projectKey configDir = some envCurrent) :
    envTarget = envCurrent := by
  rw [target_compile_yields_the_assembled_environment capabilities request projectKey configDir
        envTarget hTarget,
      current_compile_yields_the_assembled_environment request projectKey configDir envCurrent
        hCurrent]

/-- A worked witness: the environment every Claude run composes today, compiled both ways. -/
@[aw_spec (tier := T4) (ts := "packages/engine-claude-agent-sdk/src/compile.ts#compileRunRequest")]
theorem a_real_request_compiles_identically :
    let request : Request :=
      { runId := "r", sessionId := "s", cwd := "/workspace/w/s", engine := "claude-agent-sdk",
        policyReadable := true, session := .fresh,
        gateway := some { baseUrl := "https://gateway.internal", token := "run-token",
                          protocol := "anthropic-messages" },
        env := [("PATH", "/usr/bin"), ("ANTHROPIC_BASE_URL", "https://gateway.internal"),
                ("ANTHROPIC_AUTH_TOKEN", "run-token")] }
    compileTarget claudeAgentSdkCapabilities request "w" "/workspace/w/s/.claude" =
      .compiled (assembledEnv request "w" "/workspace/w/s/.claude") ∧
    compileCurrent request "w" "/workspace/w/s/.claude" =
      some (assembledEnv request "w" "/workspace/w/s/.claude") := by decide +kernel

/-- A policy arm the adapter cannot read is refused by name, never compiled with a default.

The intended difference, and the direction that matters: a run started with a *default* policy is
a run whose author believes it is narrower than it is. -/
@[aw_spec (tier := T4) (ts := "packages/engine-claude-agent-sdk/src/engine.ts#createClaudeAgentSdkEngine")]
theorem an_unreadable_policy_is_refused (capabilities : Capabilities) (request : Request)
    (projectKey configDir : String) (h : request.policyReadable = false) :
    compileTarget capabilities request projectKey configDir = .refused .enginePolicyInvalid := by
  simp [compileTarget, h]

/-- A fork on an engine that declares `fork: false` is refused rather than narrowed to a fresh
session — which would be a different conversation under the same name. -/
@[aw_spec (tier := T4) (ts := "packages/engine-claude-agent-sdk/src/engine.ts#CLAUDE_AGENT_SDK_CAPABILITIES")]
theorem a_fork_on_claude_is_refused (request : Request) (projectKey configDir prior : String)
    (hpolicy : request.policyReadable = true) (hfork : request.session = .fork prior) :
    compileTarget claudeAgentSdkCapabilities request projectKey configDir =
      .refused .engineCapabilityUnsupported := by
  simp [compileTarget, hpolicy, hfork, claudeAgentSdkCapabilities]

/-- A.11's own refusal is retained exactly: a master key still refuses, on both compiles. -/
@[aw_spec (tier := T4) (ts := "packages/engine/src/sandbox-env.ts#sandboxEnvironmentVerdict")]
theorem a_master_key_still_refuses_on_both :
    let request : Request :=
      { runId := "r", sessionId := "s", cwd := "/w", engine := "claude-agent-sdk",
        policyReadable := true, session := .fresh, gateway := none,
        env := [("ANTHROPIC_API_KEY", "provider-master-key")] }
    compileTarget claudeAgentSdkCapabilities request "w" "/w/.claude" =
      .refused .engineCredentialRefused ∧
    compileCurrent request "w" "/w/.claude" = none := by decide +kernel

end AgentWorkspace.Theorems.Refinement.EnginePortCompile
