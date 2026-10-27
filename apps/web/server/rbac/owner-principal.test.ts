import { describe, expectTypeOf, it } from 'vitest';

import type { RunOwnershipPrincipal } from '../agents/run-ownership';
import type { ProjectActor } from '../projects/runtime';
import type { RunPrincipal } from '../runs/environment';
import type { SessionApiPrincipal } from '../sessions/environment';
import type { ShareActor } from '../shares/core/runtime';
import type { ShareService } from '../shares/core/service';
import type { Principal } from './principal';

/** The `ownerPrincipalId` member of a projection, exactly as declared (optional or required). */
type OwnerField<T> = Pick<T, Extract<keyof T, 'ownerPrincipalId'>>;
type Workspace<T> = Extract<T, { readonly kind: 'workspace' }>;
type User<T> = Extract<T, { readonly kind: 'user' }>;

/**
 * Issue #509 (S1-24): every caller projection a composition root builds must carry the owner of
 * what the caller writes as a required field. Were it optional, a root that forgot to copy it would
 * still compile and silently fall back to the acting principal, so a local runtime key would own
 * what it writes again. These are type-level assertions: `pnpm typecheck` fails when one of them
 * regresses to an optional field.
 */
describe('caller projections require ownerPrincipalId', () => {
  it('requires it on every projection the composition roots build', () => {
    expectTypeOf<OwnerField<RunPrincipal>>().toEqualTypeOf<{ readonly ownerPrincipalId: string }>();
    expectTypeOf<OwnerField<User<SessionApiPrincipal>>>().toEqualTypeOf<{
      readonly ownerPrincipalId: string;
    }>();
    expectTypeOf<OwnerField<Workspace<ProjectActor>>>().toEqualTypeOf<{
      readonly ownerPrincipalId: string;
    }>();
    expectTypeOf<OwnerField<Workspace<ShareActor>>>().toEqualTypeOf<{
      readonly ownerPrincipalId: string;
    }>();
    expectTypeOf<OwnerField<Parameters<ShareService['publish']>[1]>>().toEqualTypeOf<{
      ownerPrincipalId: string;
    }>();
    expectTypeOf<OwnerField<RunOwnershipPrincipal>>().toEqualTypeOf<{
      readonly ownerPrincipalId: string;
    }>();
  });

  it('requires actsForPrincipalId when the nominal principal is rebuilt from a directory record', () => {
    type DirectoryRecord = Parameters<typeof Principal.fromDirectoryRecord>[0];
    expectTypeOf<Pick<DirectoryRecord, 'actsForPrincipalId'>>().toEqualTypeOf<{
      readonly actsForPrincipalId: string | null;
    }>();
  });
});
