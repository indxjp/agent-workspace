'use client';
/**
 * The slot the sign-up challenge (CAPTCHA or an equivalent) sits in, on every form that leaves an
 * address: the Try tab's sign-up, the enquiry form and Notify me. The provider is an open decision
 * (spec §08), so no provider's widget is drawn yet: the slot reports the answer {@link NO_CHALLENGE}
 * and the platform, which has no challenge provider configured either, answers
 * `503 email_link_unavailable` or `503 store_lead_unavailable`, which each form shows as "not
 * available yet". A chosen provider's widget goes here and reports its token through `onAnswer`.
 */
import { useEffect } from 'react';

/** The answer sent while no challenge provider is configured; no verifier accepts it. */
export const NO_CHALLENGE = 'unconfigured';

export function ChallengeSlot({ onAnswer }: { readonly onAnswer: (answer: string) => void }) {
  useEffect(() => {
    onAnswer(NO_CHALLENGE);
  }, [onAnswer]);
  return null;
}
