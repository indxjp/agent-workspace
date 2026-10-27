import AgentWorkspace.Behaviour.EnginePort

/-!
# T3 — no provider credential reaches a sandbox, for any engine (ENG-04, #303)

Spec A.11 as a property rather than as one provider's spelling. Two claims, for **every** engine
and **every** request a compile accepts:

* `ANTHROPIC_API_KEY` is absent from the compiled environment;
* every `*_API_KEY` and every `*_AUTH_TOKEN` in it holds this run's own gateway token.

The second is the one a name list cannot state, and it is what generalises past Claude: an engine
this repository has never heard of, reading a variable this model has never heard of, is covered
as long as the variable is spelled like a credential.

The declared gap, stated here rather than left to be discovered: a provider credential smuggled
through a variable named neither way is outside this theorem. `RunEnvironment`'s reserved names
and the gateway's own token issuance are what cover that, and this is the gate that catches a
regression in either.
-/

namespace AgentWorkspace.Theorems.Adversarial.EngineSandboxEnv

open AgentWorkspace.Behaviour.EnginePort AgentWorkspace.Behaviour.SandboxEnv

/-- A compile that succeeded produces an environment the sandbox contract accepts.

Quantified over the capabilities and the engine arm, so it is a statement about the port and not
about one adapter: whatever an engine's `compile` decides about its own policy, it cannot reach
the success arm with an environment that failed the check. -/
@[aw_spec (tier := T3) (doc := "docs/sdk/site/building/extending-the-platform.mdx#credentials-and-the-sandbox")
  (ts := "packages/engine/src/sandbox-env.ts#sandboxEnvironmentVerdict")
  (ts := "packages/engine-claude-agent-sdk/src/compile.ts#compileRunRequest")]
theorem compiled_environment_is_accepted (capabilities : Capabilities) (request : Request)
    (projectKey configDir : String) (env : List (String × String))
    (h : compileTarget capabilities request projectKey configDir = .compiled env) :
    accepts (runTokenFor request) env = true := by
  unfold compileTarget at h
  by_cases hp : request.policyReadable
  · cases hs : request.session with
    | fresh =>
      by_cases ha : accepts (runTokenFor request)
          (assembledEnv request projectKey configDir)
      · simp [hp, hs, ha] at h; subst h; simpa using ha
      · simp [hp, hs, ha] at h
    | resume _ =>
      by_cases ha : accepts (runTokenFor request)
          (assembledEnv request projectKey configDir)
      · simp [hp, hs, ha] at h; subst h; simpa using ha
      · simp [hp, hs, ha] at h
    | fork _ =>
      by_cases hf : capabilities.fork
      · by_cases ha : accepts (runTokenFor request)
            (assembledEnv request projectKey configDir)
        · simp [hp, hs, hf, ha] at h; subst h; simpa using ha
        · simp [hp, hs, hf, ha] at h
      · simp [hp, hs, hf] at h
  · simp [hp] at h

/-- An accepted environment carries no `ANTHROPIC_API_KEY`, under any casing. -/
@[aw_spec (tier := T3) (ts := "packages/engine/src/sandbox-env.ts#sandboxEnvironmentVerdict")]
theorem accepted_environment_has_no_master_key (runToken : String)
    (env : List (String × String)) (h : accepts runToken env = true) :
    ∀ kv ∈ env, upperAscii kv.1 ≠ providerMasterCredentialEnv := by
  intro kv hkv
  induction env with
  | nil => cases hkv
  | cons head tail ih =>
    simp only [accepts] at h
    by_cases hm : upperAscii head.1 == providerMasterCredentialEnv
    · simp [verdict, hm] at h
    · rcases List.mem_cons.1 hkv with rfl | htail
      · simpa using (by simpa using hm : ¬(upperAscii kv.1 = providerMasterCredentialEnv))
      · by_cases hc : isCredentialEnvName head.1
        · by_cases hv : head.2 != runToken
          · simp [verdict, hm, hc, hv] at h
          · refine ih ?_ htail
            simp only [accepts]
            cases hr : verdict runToken tail with
            | ok _ => simp
            | refused _ => simp [verdict, hm, hc, hv, hr] at h
        · exact ih (by simpa only [accepts, verdict, hm, hc, Bool.false_eq_true, ↓reduceIte] using h) htail

/-- An accepted environment's credential-shaped variables all hold this run's gateway token.

The load-bearing half: it names no provider and no engine, so a variable nobody has heard of is
covered by it as long as it is spelled like a credential. -/
@[aw_spec (tier := T3) (ts := "packages/engine/src/sandbox-env.ts#sandboxEnvironmentVerdict")]
theorem accepted_credential_variables_hold_the_run_token (runToken : String)
    (env : List (String × String)) (h : accepts runToken env = true) :
    ∀ kv ∈ env, isCredentialEnvName kv.1 = true → kv.2 = runToken := by
  intro kv hkv hname
  induction env with
  | nil => cases hkv
  | cons head tail ih =>
    simp only [accepts] at h
    by_cases hm : upperAscii head.1 == providerMasterCredentialEnv
    · simp [verdict, hm] at h
    · by_cases hc : isCredentialEnvName head.1
      · by_cases hv : head.2 != runToken
        · simp [verdict, hm, hc, hv] at h
        · rcases List.mem_cons.1 hkv with rfl | htail
          · simpa using (by simpa using hv : ¬(kv.2 ≠ runToken))
          · refine ih ?_ htail
            simp only [accepts]
            cases hr : verdict runToken tail with
            | ok _ => simp
            | refused _ => simp [verdict, hm, hc, hv, hr] at h
      · rcases List.mem_cons.1 hkv with rfl | htail
        · exact absurd hname (by simpa using hc)
        · exact ih (by simpa only [accepts, verdict, hm, hc, Bool.false_eq_true, ↓reduceIte] using h) htail

/-- The negative witness: a provider key in a variable this repository has never heard of is
refused, and the refusal names the variable. -/
@[aw_spec (tier := T3) (ts := "packages/engine/src/sandbox-env.ts#sandboxEnvironmentVerdict")]
theorem an_unheard_of_provider_key_is_refused :
    verdict "run-token" [("PATH", "/usr/bin"), ("SOME_FUTURE_API_KEY", "sk-live-real")] =
      .refused "SOME_FUTURE_API_KEY" := by decide +kernel

/-- The positive witness: the environment every Claude run composes today is accepted. -/
@[aw_spec (tier := T3) (ts := "packages/engine-claude-agent-sdk/src/compile.ts#compileRunRequest")]
theorem todays_composed_environment_is_accepted :
    accepts "run-token"
      [("PATH", "/usr/bin"), ("ANTHROPIC_BASE_URL", "https://gateway.internal"),
       ("ANTHROPIC_AUTH_TOKEN", "run-token"), ("AW_SESSION_MIRROR_TOKEN", "run-token"),
       ("NODE_USE_ENV_PROXY", "1")] = true := by decide +kernel

end AgentWorkspace.Theorems.Adversarial.EngineSandboxEnv
