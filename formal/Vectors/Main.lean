import Vectors.AgentFrames
import Vectors.AdversarialRunsAccess
import Vectors.AdversarialRunsStream
import Vectors.AuthzDecide
import Vectors.AuthzRunToken
import Vectors.AuthzTenancy
import Vectors.AzureGateway
import Vectors.BehaviourRuns
import Vectors.CliRuns
import Vectors.ConceptCatalog
import Vectors.ConceptConfiguration
import Vectors.ConceptIdentity
import Vectors.ConceptPublication
import Vectors.ConceptWork
import Vectors.ContractsFoundation
import Vectors.ContractsRuns
import Vectors.EngineCompose
import Vectors.EngineImages
import Vectors.EngineMastra
import Vectors.EngineOpenAiAgents
import Vectors.EnginePi
import Vectors.Engines
import Vectors.ErCore
import Vectors.ErSynthesis
import Vectors.GatewayIngress
import Vectors.EventsSse
import Vectors.LifecycleRun
import Vectors.PathGrant
import Vectors.PolicyCeiling
import Vectors.Release
import Vectors.RunCompose
import Vectors.Runs
import Vectors.SdkRuns
import Vectors.SessionState

/-!
`lake exe vectors [outDir]` — writes every family's differential test vectors as JSON under
`outDir` (default `generated/vectors`). The TypeScript conformance suite in `tests/formal/`
replays them against the real contracts, decision functions, SDK and CLI. To add a family, add
its `Vectors/<Family>.lean` module and one line to `families`.
-/

open Lean

def families : List (String × List (String × Json)) :=
  [("agent-frames", Vectors.AgentFrames.files),
   ("adversarial-runs-access", Vectors.AdversarialRunsAccess.files),
   ("adversarial-runs-stream", Vectors.AdversarialRunsStream.files),
   ("authz-decide", Vectors.AuthzDecide.files),
   ("authz-run-token", Vectors.AuthzRunToken.files),
   ("authz-tenancy", Vectors.AuthzTenancy.files),
   ("azure-gateway", Vectors.AzureGateway.files),
   ("behaviour-runs", Vectors.BehaviourRuns.files),
   ("cli-runs", Vectors.CliRuns.files),
   ("concept-catalog", Vectors.ConceptCatalog.files),
   ("concept-configuration", Vectors.ConceptConfiguration.files),
   ("concept-identity", Vectors.ConceptIdentity.files),
   ("concept-publication", Vectors.ConceptPublication.files),
   ("concept-work", Vectors.ConceptWork.files),
   ("contracts-foundation", Vectors.ContractsFoundation.files),
   ("contracts-runs", Vectors.ContractsRuns.files),
   ("engine-compose", Vectors.EngineCompose.files),
   ("engine-images", Vectors.EngineImages.files),
   ("engine-mastra", Vectors.EngineMastra.files),
   ("engine-openai-agents", Vectors.EngineOpenAiAgents.files),
   ("engine-pi", Vectors.EnginePi.files),
   ("engines", Vectors.Engines.files),
   ("er-core", Vectors.ErCore.files),
   ("er-synthesis", Vectors.ErSynthesis.files),
   ("events-sse", Vectors.EventsSse.files),
   ("gateway-ingress", Vectors.GatewayIngress.files),
   ("lifecycle-run", Vectors.LifecycleRun.files),
   ("path-grant", Vectors.PathGrant.files),
   ("policy-ceiling", Vectors.PolicyCeiling.files),
   ("release", Vectors.Release.files),
   ("run-compose", Vectors.RunCompose.files),
   ("runs", Vectors.Runs.files),
   ("sdk-runs", Vectors.SdkRuns.files),
   ("session-state", Vectors.SessionState.files)]

def main (args : List String) : IO UInt32 := do
  let outDir : System.FilePath := args.headD "generated/vectors"
  let mut count := 0
  for (family, files) in families do
    Vectors.writeFamily family files outDir
    count := count + files.length
  IO.eprintln s!"vectors: {count} files"
  return 0
