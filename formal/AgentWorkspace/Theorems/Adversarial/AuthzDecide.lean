import AgentWorkspace.Authz.Decide

/-!
T3 — what a caller cannot obtain from `decide()`, over **all** inputs it controls (the role string
its credential carries, the method, every byte of the path, the scope id, and the ownership fact
the handler reports).

Attacker model (`decide()`'s share of it): the attacker holds a browser token or a membership of
one role, chooses the method and the raw pathname, and tries to (a) reach a route its scope's
grammar excludes, (b) reach another run than the one its run scope names, (c) list runs or mint a
token with a scope, (d) disguise an `/api` path as public by case, backslashes, percent-encoding or
dot segments, (e) reach a resource segment nobody classified, or (f) reach an owner-only resource
with a narrower role.
-/

namespace AgentWorkspace.Theorems.Adversarial.AuthzDecide

open AgentWorkspace AgentWorkspace.Concepts.Membership AgentWorkspace.Concepts.BrowserToken
  AgentWorkspace.Authz.Roles AgentWorkspace.Authz.Resources AgentWorkspace.Authz.Permissions
  AgentWorkspace.Authz.TokenScope AgentWorkspace.Authz.Surface AgentWorkspace.Authz.Decide

/-- The shape of any decision `decideOrdinary` can return once the role parsed. -/
private theorem allow_cases (q : Query) (f : Option RouteFacts) (h : decideOrdinary q = .allow f) :
    (classifyPath q.path = .«public» ∧ f = none) ∨
      ∃ role res sub id op, parseRoleInput q.role = some role ∧ classifyPath q.path = .api ∧
        parsePath q.path = .ok res sub id ∧ parseOperation q.method sub = .ok op ∧
        (q.scope.bind fun s => checkTokenScope s res op sub id) = none ∧
        applyGrant (grantFor role res op) q.ownership = true ∧
        f = some ⟨res, RouteOperation.ofOperation op, grantFor role res op⟩ := by
  unfold decideOrdinary at h
  cases hr : parseRoleInput q.role with
  | none => simp [hr] at h
  | some role =>
    simp only [hr] at h
    cases hs : classifyPath q.path with
    | «public» => simp [hs] at h; exact Or.inl ⟨rfl, h.symm⟩
    | page => simp [hs] at h
    | api =>
      simp only [hs] at h
      cases hp : parsePath q.path with
      | ok res sub id =>
        simp only [hp] at h
        cases ho : parseOperation q.method sub with
        | refused m => simp [ho] at h
        | ok op =>
          simp only [ho, decideClassified] at h
          split at h
          · cases h
          · rename_i hsc
            split at h
            · rename_i hap
              cases h
              exact Or.inr ⟨role, res, sub, id, op, rfl, rfl, rfl, ho, hsc, hap, rfl⟩
            · cases h
      | _ => simp [hp] at h

/-- A run-scoped browser token is allowed only reads of its run, including equivalent UUID
spellings of its id (the row or a sub-resource read with `GET`/`HEAD`). -/
@[aw_spec (tier := T3) (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")
  (ts := "apps/web/server/rbac/decide.ts#checkTokenScope")]
theorem run_scoped_token_reaches_only_reads_of_its_run (q : Query) (run : RunId)
    (f : Option RouteFacts) (hq : q.scope = some (.run run)) (h : decideOrdinary q = .allow f) :
    classifyPath q.path = .«public» ∨
      ∃ sub id, parsePath q.path = .ok .runs sub (some id) ∧
        sameRunId (some id) run.val = true ∧
        parseOperation q.method sub = .ok .read := by
  rcases allow_cases q f h with ⟨hs, _⟩ | ⟨role, res, sub, id, op, _, _, hp, ho, hsc, _, _⟩
  · exact Or.inl hs
  · right
    rw [hq] at hsc
    simp only [Option.bind_some, checkTokenScope, inGrammar, grammar, Scope.kind, Scope.id] at hsc
    cases res <;> cases op <;> simp at hsc
    cases id with
    | none => simp at hsc
    | some i =>
      simp at hsc
      exact ⟨sub, i, hp, hsc, ho⟩

example : classifyPath "/api/runs/r/events" = .«public» ∨
    ∃ sub id, parsePath "/api/runs/r/events" = .ok .runs sub (some id) ∧
      sameRunId (some id) "r" = true ∧ parseOperation "GET" sub = .ok .read :=
  run_scoped_token_reaches_only_reads_of_its_run ⟨"viewer", "GET", "/api/runs/r/events", .own,
    some (.run ⟨"r"⟩)⟩ ⟨"r"⟩ (some ⟨.runs, .read, .own⟩) rfl (by decide)

/-- A session-scoped browser token is allowed nothing but reads of a single run, the `run` verb
on `agents` (starting a run) and the `run` verb on a run's `feedback` sub-resource (rating it),
outside the public surface. No other `runs` sub-resource reaches the `run` verb: `interrupt` stays
out. -/
@[aw_spec (tier := T3) (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")
  (ts := "apps/web/server/rbac/decide.ts#checkTokenScope")]
theorem session_scoped_token_reaches_only_run_reads_and_agent_runs (q : Query) (session : SessionId)
    (f : Option RouteFacts) (hq : q.scope = some (.session session)) (h : decideOrdinary q = .allow f) :
    classifyPath q.path = .«public» ∨
      (∃ sub id, parsePath q.path = .ok .runs sub (some id) ∧ parseOperation q.method sub = .ok .read) ∨
      (∃ sub id, parsePath q.path = .ok .agents sub id ∧ parseOperation q.method sub = .ok .run) ∨
      (∃ id, parsePath q.path = .ok .runs (some "feedback") id ∧
        parseOperation q.method (some "feedback") = .ok .run) := by
  rcases allow_cases q f h with ⟨hs, _⟩ | ⟨role, res, sub, id, op, _, _, hp, ho, hsc, _, _⟩
  · exact Or.inl hs
  · right
    rw [hq] at hsc
    simp only [Option.bind_some, checkTokenScope, inGrammar, grammar, Scope.kind] at hsc
    cases res <;> cases op <;> simp at hsc
    · exact Or.inr (Or.inl ⟨sub, id, hp, ho⟩)
    · obtain ⟨i, rfl⟩ := Option.ne_none_iff_exists'.mp hsc
      exact Or.inl ⟨sub, i, hp, ho⟩
    · subst hsc
      exact Or.inr (Or.inr ⟨id, hp, ho⟩)

example : classifyPath "/api/agents/a/runs" = .«public» ∨
    (∃ sub id, parsePath "/api/agents/a/runs" = .ok .runs sub (some id) ∧
      parseOperation "POST" sub = .ok .read) ∨
    (∃ sub id, parsePath "/api/agents/a/runs" = .ok .agents sub id ∧
      parseOperation "POST" sub = .ok .run) ∨
    (∃ id, parsePath "/api/agents/a/runs" = .ok .runs (some "feedback") id ∧
      parseOperation "POST" (some "feedback") = .ok .run) :=
  session_scoped_token_reaches_only_run_reads_and_agent_runs ⟨"builder", "POST", "/api/agents/a/runs",
    .own, some (.session ⟨"s"⟩)⟩ ⟨"s"⟩ (some ⟨.agents, .run, .own⟩) rfl (by decide)

/-- The feedback cell is keyed by its sub-resource and belongs to the session scope alone: a run
scope never reaches `POST /api/runs/:id/feedback`, and the session scope's `run` verb on `runs`
does not extend to `interrupt` (or any other sub-resource but `feedback`). -/
@[aw_spec (tier := T3) (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")
  (ts := "apps/web/server/rbac/decide.ts#checkTokenScope")]
theorem feedback_cell_is_session_only_and_sub_keyed (run : RunId) (session : SessionId)
    (id : Option String) :
    checkTokenScope (.run run) .runs .run (some "feedback") id = some .notInGrammar ∧
      checkTokenScope (.session session) .runs .run (some "interrupt") id = some .notInGrammar ∧
      ∀ sub, sub ≠ some "feedback" →
        checkTokenScope (.session session) .runs .run sub id = some .notInGrammar := by
  refine ⟨?_, ?_, ?_⟩
  · simp [checkTokenScope, inGrammar, grammar, Scope.kind]
  · simp [checkTokenScope, inGrammar, grammar, Scope.kind]
  · intro sub hsub
    simp [checkTokenScope, inGrammar, grammar, Scope.kind, Ne.symm hsub]


/-- A path that parses with a sub-resource also names a row: `/api/<resource>/:id/<sub>`. -/
private theorem parsed_sub_names_a_row (path : String) (res : Resource) (s : String)
    (id : Option String) (hp : parsePath path = .ok res (some s) id) : id.isSome = true := by
  unfold parsePath at hp
  generalize segmentsOf path = segs at hp
  unfold parseSegments at hp
  split at hp
  · split at hp
    · cases hp
    · split at hp
      · cases hp
      · cases hp
      · split at hp
        · cases hp
        · cases hp; rfl
      · cases hp
  · cases hp

/-- No browser token of either kind is ever allowed to mint a token, and when it is allowed a read
of `runs`, its path names a row: `tokens` is in no grammar, and a scope reads one run, never the
collection. -/
@[aw_spec (tier := T3) (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")
  (ts := "apps/web/server/rbac/decide.ts#TOKEN_SCOPE_GRAMMAR")]
theorem scoped_token_never_mints_or_lists (q : Query) (s : Scope) (hq : q.scope = some s)
    (fact : RouteFacts) (h : decideOrdinary q = .allow (some fact)) :
    fact.resource ≠ .tokens ∧
      (fact.resource = .runs → ∃ sub id, parsePath q.path = .ok .runs sub (some id)) := by
  rcases allow_cases q _ h with ⟨_, hf⟩ | ⟨role, res, sub, id, op, _, _, hp, _, hsc, _, hf⟩
  · cases hf
  · cases hf
    rw [hq] at hsc
    simp only [Option.bind_some] at hsc
    refine ⟨?_, ?_⟩
    · dsimp only
      intro ht; subst ht
      cases s <;> cases op <;> simp [checkTokenScope, inGrammar, grammar, Scope.kind] at hsc
    · dsimp only
      intro hr; subst hr
      cases id with
      | some i => exact ⟨sub, i, hp⟩
      | none =>
        cases s <;> cases op <;> simp [checkTokenScope, inGrammar, grammar, Scope.kind] at hsc
        subst hsc
        simpa using parsed_sub_names_a_row q.path .runs "feedback" none hp

example : Resource.runs ≠ .tokens ∧
    (Resource.runs = .runs → ∃ sub id, parsePath "/api/runs/r" = .ok .runs sub (some id)) :=
  scoped_token_never_mints_or_lists ⟨"owner", "GET", "/api/runs/r", .own, some (.run ⟨"r"⟩)⟩
    (.run ⟨"r"⟩) rfl ⟨.runs, .read, .any⟩ (by decide)

private theorem parsed_sub_is_classified (path : String) (res : Resource) (sub id : Option String)
    (s : String) (hp : parsePath path = .ok res sub id) (hs : sub = some s) :
    s ∈ subResources res := by
  subst hs
  unfold parsePath at hp
  generalize segmentsOf path = segs at hp
  unfold parseSegments at hp
  split at hp
  · split at hp
    · cases hp
    · split at hp
      · cases hp
      · cases hp
      · split at hp
        · cases hp
        · rename_i hsub
          cases hp
          exact List.mem_of_find?_eq_some hsub
      · cases hp
  · cases hp

/-- Every `allow` that names a resource names it by a classified route: the path is on the `api`
surface and parses as `/api/<the allowed resource>[/:id[/<sub>]]`, with any sub one that
`SUB_RESOURCES` classifies under that resource. -/
@[aw_spec (tier := T3) (doc := "docs/adr/0015-gates-decide-on-positive-assertions.md#decision")
  (ts := "apps/web/server/rbac/decide.ts#parsePath")]
theorem allow_needs_a_classified_route (q : Query) (fact : RouteFacts)
    (h : decideOrdinary q = .allow (some fact)) :
    classifyPath q.path = .api ∧ ∃ sub id, parsePath q.path = .ok fact.resource sub id ∧
      (∀ s, sub = some s → s ∈ subResources fact.resource) := by
  rcases allow_cases q _ h with ⟨_, hf⟩ | ⟨role, res, sub, id, op, _, hs, hp, _, _, _, hf⟩
  · cases hf
  · cases hf
    exact ⟨hs, sub, id, hp, fun s hsub => parsed_sub_is_classified q.path res sub id s hp hsub⟩

example : classifyPath "/api/runs/r/events" = .api ∧ ∃ sub id,
    parsePath "/api/runs/r/events" = .ok Resource.runs sub id ∧
      (∀ s, sub = some s → s ∈ subResources .runs) :=
  allow_needs_a_classified_route ⟨"owner", "GET", "/api/runs/r/events", .own, none⟩
    ⟨.runs, .read, .any⟩ (by decide)

/-- Secrets are Owner-only: no other role, whatever path spelling, method, ownership or scope it
supplies, is ever allowed on `secrets`. -/
@[aw_spec (tier := T3) (doc := "docs/spec.md#21-users-and-rbac")
  (ts := "apps/web/server/rbac/permissions.ts#POLICY")]
theorem secrets_are_owner_only (q : Query) (fact : RouteFacts) (h : decideOrdinary q = .allow (some fact))
    (hs : fact.resource = .secrets) : parseRoleInput q.role = some .owner := by
  rcases allow_cases q _ h with ⟨_, hf⟩ | ⟨role, res, sub, id, op, hr, _, _, _, _, hap, hf⟩
  · cases hf
  · cases hf
    dsimp only at hs; subst hs
    rw [hr]
    revert hap
    cases role <;> cases op <;> cases q.ownership <;> decide

example : parseRoleInput "owner" = some .owner :=
  secrets_are_owner_only ⟨"owner", "GET", "/api/secrets", .notApplicable, none⟩
    ⟨.secrets, .read, .any⟩ (by decide) rfl

/-- A Viewer writes nothing but its own shares and workspace memberships: every write it is
allowed is on `shares` or `workspaces`, for a row it owns or a collection. -/
@[aw_spec (tier := T3) (doc := "docs/spec.md#21-users-and-rbac")
  (ts := "apps/web/server/rbac/permissions.ts#POLICY")]
theorem viewer_writes_only_its_own_shares_and_workspaces (q : Query) (fact : RouteFacts)
    (hr : parseRoleInput q.role = some .viewer) (h : decideOrdinary q = .allow (some fact))
    (hw : fact.operation = .write) :
    (fact.resource = .shares ∨ fact.resource = .workspaces) ∧
      (q.ownership = .own ∨ q.ownership = .notApplicable) := by
  rcases allow_cases q _ h with ⟨_, hf⟩ | ⟨role, res, sub, id, op, hr', _, _, _, _, hap, hf⟩
  · cases hf
  · cases hf
    rw [hr] at hr'; cases hr'
    cases op <;> simp [RouteOperation.ofOperation] at hw
    revert hap
    cases res <;> cases q.ownership <;> decide

example : (Resource.shares = .shares ∨ Resource.shares = .workspaces) ∧
    (Ownership.own = .own ∨ Ownership.own = .notApplicable) :=
  viewer_writes_only_its_own_shares_and_workspaces ⟨"viewer", "DELETE", "/api/shares/s", .own, none⟩
    ⟨.shares, .write, .own⟩ (by decide) (by decide) rfl

/-! ## The surface cannot be disguised -/

private theorem formsAux_head (n : Nat) (cur : List Char) (fs : List (List Char))
    (h : formsAux (n + 1) cur = some fs) : replaceBackslash cur ∈ fs := by
  dsimp only [formsAux] at h
  split at h
  · cases h
  · split at h
    · cases h; simp
    · obtain ⟨rest, _, rfl⟩ := Option.map_eq_some_iff.mp h
      simp

/-- No case, backslash or duplicate-slash variant of `/api` escapes protection: whenever the
lower-cased, backslash-separated pathname is under `/api`, the surface is `api`. -/
@[aw_spec (tier := T3) (doc := "docs/spec.md#34-api-design")
  (ts := "apps/web/server/auth/paths.ts#classifyPath")]
theorem api_variants_are_protected (raw : List Char) (hne : raw ≠ [])
    (h : isUnder (asciiLower (replaceBackslash raw)) apiPrefix = true) : classifyChars raw = .api := by
  cases raw with
  | nil => exact absurd rfl hne
  | cons c cs =>
    unfold classifyChars
    dsimp only
    split
    · rfl
    · cases hf : candidateForms (c :: cs) with
      | none => rfl
      | some fs =>
        have hmem := formsAux_head 3 (c :: cs) fs hf
        have : fs.any (fun f => isUnder (asciiLower f) apiPrefix) = true :=
          List.any_eq_true.mpr ⟨_, hmem, h⟩
        simp [this]

example : classifyChars "/API\\runs".toList = .api :=
  api_variants_are_protected _ (by decide) (by decide)

/-- The public verdict needs the raw pathname itself (backslashes read as slashes) to be under
`/p`, case-sensitively, and not under `/api` in any case. -/
@[aw_spec (tier := T3) (doc := "docs/spec.md#34-api-design")
  (ts := "apps/web/server/auth/paths.ts#classifyPath")]
theorem public_needs_the_raw_path_under_p (raw : List Char) (h : classifyChars raw = .«public») :
    isUnder (replaceBackslash raw) publicPrefix = true ∧
      isUnder (asciiLower (replaceBackslash raw)) apiPrefix = false := by
  cases raw with
  | nil => simp [classifyChars] at h
  | cons c cs =>
    unfold classifyChars at h
    dsimp only at h
    split at h
    · cases h
    · cases hf : candidateForms (c :: cs) with
      | none => simp [hf] at h
      | some fs =>
        have hmem := formsAux_head 3 (c :: cs) fs hf
        simp only [hf] at h
        split at h
        · cases h
        · rename_i hany
          split at h
          · rename_i hall
            refine ⟨List.all_eq_true.mp hall _ hmem, ?_⟩
            cases hx : isUnder (asciiLower (replaceBackslash (c :: cs))) apiPrefix
            · rfl
            · exact absurd (List.any_eq_true.mpr ⟨_, hmem, hx⟩) hany
          · cases h

example : isUnder (replaceBackslash "/p/x".toList) publicPrefix = true ∧
    isUnder (asciiLower (replaceBackslash "/p/x".toList)) apiPrefix = false :=
  public_needs_the_raw_path_under_p _ (by decide)

private theorem addContinuations_one (a b : Nat) : addContinuations a [b] = a * 64 + b % 64 := rfl
private theorem addContinuations_two (a b c : Nat) :
    addContinuations a [b, c] = (a * 64 + b % 64) * 64 + c % 64 := rfl
private theorem addContinuations_three (a b c d : Nat) :
    addContinuations a [b, c, d] = ((a * 64 + b % 64) * 64 + c % 64) * 64 + d % 64 := rfl

/-- Every UTF-8 sequence the decoder accepts is the shortest form of a Unicode scalar value: a
2-byte sequence encodes at least `U+0080`, a 3-byte one at least `U+0800`, a 4-byte one lies in
`U+10000`…`U+10FFFF`, no accepted code point is a surrogate, and only 2- to 4-byte sequences are
read. An overlong `/` or `.` therefore never decodes into a path separator or dot segment. -/
@[aw_spec (tier := T3) (doc := "docs/spec.md#34-api-design")
  (ts := "apps/web/server/auth/paths.ts#candidateForms")]
theorem utf8_accepts_only_shortest_scalar_values (lead : Nat) (conts : List Nat) (cp : Nat)
    (h : utf8CodePoint lead conts = some cp) :
    (conts.length = 1 → 0x80 ≤ cp) ∧ (conts.length = 2 → 0x800 ≤ cp) ∧
      (conts.length = 3 → 0x10000 ≤ cp ∧ cp ≤ 0x10FFFF) ∧ ¬ (0xD800 ≤ cp ∧ cp ≤ 0xDFFF) ∧
      1 ≤ conts.length ∧ conts.length ≤ 3 := by
  rcases conts with _ | ⟨b1, _ | ⟨b2, _ | ⟨b3, _ | ⟨b4, rest⟩⟩⟩⟩ <;>
    simp only [utf8CodePoint, List.length] at h ⊢
  all_goals first
    | (cases h; done)
    | (split at h
       · cases h; simp only [addContinuations_one, addContinuations_two, addContinuations_three] at *
         omega
       · cases h)

example : (([0xC2] : List Nat).length = 1 → 0x80 ≤ 0x80) ∧ (([0xC2] : List Nat).length = 2 → 0x800 ≤ 0x80) ∧
    (([0xC2] : List Nat).length = 3 → 0x10000 ≤ 0x80 ∧ 0x80 ≤ 0x10FFFF) ∧
    ¬ (0xD800 ≤ 0x80 ∧ 0x80 ≤ 0xDFFF) ∧ 1 ≤ ([0xC2] : List Nat).length ∧
    ([0xC2] : List Nat).length ≤ 3 :=
  utf8_accepts_only_shortest_scalar_values 0xC2 [0x80] 0x80 (by decide)

/-- `decodeURIComponent` throws on every overlong 2-byte form (`%C0`/`%C1` with any continuation
byte), on the overlong 3- and 4-byte forms and the out-of-range 4-byte form at their boundaries, and
on the surrogate range `%ED%A0%80`…`%ED%BF%BF`, while it decodes the shortest forms on either
side of each bound. -/
@[aw_spec (tier := T3) (doc := "docs/spec.md#34-api-design")
  (ts := "apps/web/server/auth/paths.ts#candidateForms")]
theorem uri_decode_rejects_overlong_and_surrogate_forms :
    (∀ lead ∈ [0xC0, 0xC1], ∀ c < 64, utf8CodePoint lead [0x80 + c] = none) ∧
      (∀ c1 < 32, utf8CodePoint 0xED [0xA0 + c1, 0x80] = none ∧
        utf8CodePoint 0xED [0xA0 + c1, 0xBF] = none) ∧
      (["%C0%AF", "%C0%AE", "%C1%BF", "%E0%80%AF", "%E0%9F%BF", "%ED%A0%80", "%ED%BF%BF",
          "%F0%80%80%AF", "%F0%8F%BF%BF", "%F4%90%80%80"].all
        fun s => decodeURIComponent s.toList == none) = true ∧
      (["%C2%80", "%DF%BF", "%E0%A0%80", "%ED%9F%BF", "%EE%80%80", "%F0%90%80%80",
          "%F4%8F%BF%BF"].map fun s => (decodeURIComponent s.toList).map (·.map Char.toNat)) =
        [some [0x80], some [0x7FF], some [0x800], some [0xD7FF], some [0xE000], some [0x10000],
          some [0x10FFFF]] := by
  decide

/-- Traversal and encoding attacks on the prefix rule: dot segments (plain, percent-encoded, doubly
encoded, overlong UTF-8), overlong slashes, surrogate escapes, encoded slashes and letters,
backslashes, doubled slashes and case all land on the protected surface, and an upper-case `/P/` is
not released as public. -/
@[aw_spec (tier := T3) (doc := "docs/spec.md#34-api-design")
  (ts := "apps/web/server/auth/paths.ts#classifyPath")]
theorem encoded_traversal_stays_protected :
    ["/API/runs", "/Api/Runs", "/api\\runs", "//api/runs", "/p/../api/runs", "/p/./../api",
      "/p/%2e%2e/api/runs", "/p/%2E%2E/api/runs", "/p/%252e%252e/api/runs", "/p/..%2fapi/runs",
      "/p%2f..%2fapi/runs", "/%61pi/runs", "/%2561pi/runs", "/p/%C0%AE%C0%AE/api", "/p/%zz",
      "/p/%E0%80%AE", "/p/%C0%AFx", "/p%C0%AFapi", "/p/%ED%A0%80", "/p/%F0%80%80%AF",
      "/p\\..\\api\\runs", "api/runs", ""].all
      (classifyPath · == .api) = true ∧
      classifyPath "/P/x" = .page ∧ classifyPath "/p/x" = .«public» ∧ classifyPath "/p" = .«public» ∧
      classifyPath "/apiary" = .page ∧ classifyPath "/api" = .api := by decide

private theorem takeContinuations_zero (cs : List Char) : takeContinuations 0 cs = some ([], cs) :=
  rfl

private theorem takeContinuations_succ (n : Nat) (cs : List Char) :
    takeContinuations (n + 1) cs =
      match takeEscape cs with
      | some (b, rest) =>
        if b / 64 = 2 then
          match takeContinuations n rest with
          | some (bs, rest') => some (b :: bs, rest')
          | none => none
        else none
      | none => none := rfl

private theorem decodeAux_cons (fuel : Nat) (c : Char) (cs : List Char) :
    decodeAux (fuel + 1) (c :: cs) =
      if c = '%' then
        match takeEscape (c :: cs) with
        | none => none
        | some (lead, rest) =>
          match continuationCount lead with
          | none => none
          | some 0 =>
            match decodeAux fuel rest with
            | some out => some (Char.ofNat lead :: out)
            | none => none
          | some n =>
            match takeContinuations n rest with
            | none => none
            | some (conts, rest') =>
              match utf8CodePoint lead conts with
              | none => none
              | some cp =>
                match decodeAux fuel rest' with
                | some out => some (Char.ofNat cp :: out)
                | none => none
      else
        match decodeAux fuel cs with
        | some out => some (c :: out)
        | none => none := rfl

private theorem takeContinuations_spec : ∀ (n : Nat) (cs : List Char) (bs : List Nat)
    (rest : List Char), takeContinuations n cs = some (bs, rest) →
    bs.length = n ∧ ∀ b ∈ bs, b / 64 = 2
  | 0, cs, bs, rest, h => by
    simp only [takeContinuations_zero, Option.some.injEq, Prod.mk.injEq] at h
    obtain ⟨rfl, -⟩ := h
    simp
  | n + 1, cs, bs, rest, h => by
    rw [takeContinuations_succ] at h
    split at h
    · rename_i b r _
      split at h
      · rename_i hb
        split at h
        · rename_i bs' r' hr
          simp only [Option.some.injEq, Prod.mk.injEq] at h
          obtain ⟨rfl, -⟩ := h
          obtain ⟨hl, ha⟩ := takeContinuations_spec n r bs' r' hr
          refine ⟨by simp [hl], ?_⟩
          intro x hx
          simp only [List.mem_cons] at hx
          rcases hx with rfl | hx
          · exact hb
          · exact ha x hx
        · cases h
      · cases h
    · cases h

private theorem continuationCount_spec (lead n : Nat) (h : continuationCount lead = some n) :
    (n = 0 ∧ lead < 0x80) ∨
      (0xC0 ≤ lead ∧ lead < 0xF8 ∧ n = if lead < 0xE0 then 1 else if lead < 0xF0 then 2 else 3) := by
  unfold continuationCount at h
  repeat' split at h
  all_goals simp only [Option.some.injEq, reduceCtorEq] at h
  all_goals subst h
  all_goals first
    | (left; omega)
    | (right; refine ⟨by omega, by omega, ?_⟩; split <;> (try split) <;> omega)

private theorem utf8CodePoint_lead_bounds (lead : Nat) (conts : List Nat) (cp : Nat)
    (h : utf8CodePoint lead conts = some cp) (hlo : 0xC0 ≤ lead) (hhi : lead < 0xF8)
    (hlen : conts.length = if lead < 0xE0 then 1 else if lead < 0xF0 then 2 else 3) :
    0xC2 ≤ lead ∧ lead ≤ 0xF4 := by
  rcases conts with _ | ⟨b1, _ | ⟨b2, _ | ⟨b3, _ | ⟨b4, rest⟩⟩⟩⟩ <;>
    simp only [utf8CodePoint, List.length] at h hlen
  all_goals first
    | (cases h; done)
    | (split at h
       · cases h
         simp only [addContinuations_one, addContinuations_two, addContinuations_three] at *
         split at hlen <;> (try split at hlen) <;> omega
       · cases h)

/-- Every step of `decodeURIComponent` that succeeds reads well-formed UTF-8: a plain character, or
a `%HH` escape whose lead byte is ASCII, or a lead byte in `C2`…`F4` followed by exactly the number of
continuation bytes (`10xxxxxx`) it announces, encoding a scalar value, and the rest decodes too. So
by induction on the input no lone continuation byte, lead byte `F5`…`FF`, truncated or interrupted
sequence, overlong form or surrogate is ever accepted anywhere in it. -/
@[aw_spec (tier := T3) (doc := "docs/spec.md#34-api-design")
  (ts := "apps/web/server/auth/paths.ts#candidateForms")]
theorem decode_step_is_well_formed (fuel : Nat) (c : Char) (cs out : List Char)
    (h : decodeAux (fuel + 1) (c :: cs) = some out) :
    (c ≠ '%' ∧ ∃ tail, decodeAux fuel cs = some tail) ∨
      (∃ lead rest, c = '%' ∧ takeEscape (c :: cs) = some (lead, rest) ∧
        ((lead < 0x80 ∧ ∃ tail, decodeAux fuel rest = some tail) ∨
          (0xC2 ≤ lead ∧ lead ≤ 0xF4 ∧ ∃ conts rest' cp tail,
            takeContinuations conts.length rest = some (conts, rest') ∧
            conts.length = (if lead < 0xE0 then 1 else if lead < 0xF0 then 2 else 3) ∧
            (∀ b ∈ conts, b / 64 = 2) ∧ utf8CodePoint lead conts = some cp ∧
            decodeAux fuel rest' = some tail))) := by
  rw [decodeAux_cons] at h
  split at h
  · rename_i hc
    right
    split at h
    · cases h
    · rename_i lead rest hesc
      refine ⟨lead, rest, hc, hesc, ?_⟩
      split at h
      · cases h
      · rename_i hcc
        split at h
        · rename_i tail ht
          have hlt : lead < 0x80 := by
            rcases continuationCount_spec _ _ hcc with ⟨_, h⟩ | ⟨_, _, h⟩
            · exact h
            · split at h <;> (try split at h) <;> omega
          exact Or.inl ⟨hlt, tail, ht⟩
        · cases h
      · rename_i n hn0 hcc
        split at h
        · cases h
        · rename_i conts rest' htc
          split at h
          · cases h
          · rename_i cp hcp
            split at h
            · rename_i tail ht
              obtain ⟨hl, ha⟩ := takeContinuations_spec _ _ _ _ htc
              rcases continuationCount_spec _ _ hcc with ⟨hn, _⟩ | ⟨hlo, hhi, hn⟩
              · exact absurd hn hn0
              · have hlen : conts.length = if lead < 0xE0 then 1 else if lead < 0xF0 then 2 else 3 :=
                  hl.trans hn
                obtain ⟨b1, b2⟩ := utf8CodePoint_lead_bounds lead conts cp hcp hlo hhi hlen
                right
                exact ⟨b1, b2, conts, rest', cp, tail, hl ▸ htc, hlen, ha, hcp, ht⟩
            · cases h
  · rename_i hc
    left
    split at h
    · rename_i tail ht
      exact ⟨hc, tail, ht⟩
    · cases h

example : ('%' : Char) ≠ '%' ∧ (∃ tail, decodeAux 5 "C3%A9".toList = some tail) ∨
    (∃ lead rest, ('%' : Char) = '%' ∧ takeEscape "%C3%A9".toList = some (lead, rest) ∧
      ((lead < 0x80 ∧ ∃ tail, decodeAux 5 rest = some tail) ∨
        (0xC2 ≤ lead ∧ lead ≤ 0xF4 ∧ ∃ conts rest' cp tail,
          takeContinuations conts.length rest = some (conts, rest') ∧
          conts.length = (if lead < 0xE0 then 1 else if lead < 0xF0 then 2 else 3) ∧
          (∀ b ∈ conts, b / 64 = 2) ∧ utf8CodePoint lead conts = some cp ∧
          decodeAux 5 rest' = some tail))) :=
  decode_step_is_well_formed 5 '%' "C3%A9".toList ['é'] (by decide)

/-- An upper-case hex digit. -/
private def hexDigit (d : Nat) : Char := "0123456789ABCDEF".toList.getD d '0'
/-- The `%HH` escape of a byte. -/
private def esc (b : Nat) : String := String.ofList ['%', hexDigit (b / 16), hexDigit (b % 16)]

/-- `decodeURIComponent` throws where JavaScript's does on malformed bytes: after a 2-, 3- or 4-byte
lead, any byte that is not a continuation byte (`%C2%41`, `%E0%A0%41`, `%F0%90%80%41`); a lone
continuation byte `%80`…`%BF`; and every lead byte `%F5`…`%FF`, whatever continuation bytes follow. -/
@[aw_spec (tier := T3) (doc := "docs/spec.md#34-api-design")
  (ts := "apps/web/server/auth/paths.ts#candidateForms")]
theorem uri_decode_rejects_bad_lead_and_continuation_bytes :
    (∀ b < 256, b / 64 ≠ 2 →
      decodeURIComponent (esc 0xC2 ++ esc b).toList = none ∧
      decodeURIComponent (esc 0xE0 ++ esc 0xA0 ++ esc b).toList = none ∧
      decodeURIComponent (esc 0xF0 ++ esc 0x90 ++ esc 0x80 ++ esc b).toList = none) ∧
    (∀ b < 256, 0x80 ≤ b → b < 0xC0 →
      decodeURIComponent (esc b).toList = none ∧
      decodeURIComponent (esc b ++ esc 0x80).toList = none) ∧
    (∀ b < 256, 0xF5 ≤ b →
      decodeURIComponent (esc b ++ esc 0x80 ++ esc 0x80 ++ esc 0x80).toList = none ∧
      decodeURIComponent (esc b ++ esc 0x8F ++ esc 0xBF ++ esc 0xBF).toList = none ∧
      decodeURIComponent (esc b ++ esc 0x80 ++ esc 0x80 ++ esc 0x80 ++ esc 0x80).toList = none) ∧
    ["%C2", "%E0%A0", "%F0%90%80", "%C2%C2%80"].all (decodeURIComponent ·.toList == none) = true ∧
    (decodeURIComponent (esc 0xC2 ++ esc 0xBF).toList).map (·.map Char.toNat) = some [0xBF] := by
  decide +kernel

end AgentWorkspace.Theorems.Adversarial.AuthzDecide
