import Lean.Data.Json
import AgentWorkspace.Prelude.WireEnum

/-!
# JSON codecs for wire enumerations

A `WireEnum` is encoded as its wire string and decoded only from exactly that string, so an
enumeration's JSON codec is derived from its `WireEnum` instance and inherits its round-trip.
-/

namespace AgentWorkspace.WireEnum

open Lean

variable {α : Type} [WireEnum α]

/-- The JSON value of a wire enumeration member. -/
def toJsonValue (a : α) : Json := Json.str (toWire a)

/-- Decode a JSON value; only a string spelling a member decodes. -/
def fromJsonValue? : Json → Option α
  | .str s => ofWire? s
  | _ => none

theorem fromJsonValue?_toJsonValue (a : α) : fromJsonValue? (toJsonValue a) = some a := by
  simp [toJsonValue, fromJsonValue?, ofWire?_toWire]

end AgentWorkspace.WireEnum
