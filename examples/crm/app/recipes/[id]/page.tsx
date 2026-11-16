'use client';
import { RecipeGraph } from '@indx-workspace/app/react';
import { use } from 'react';

import { theme } from '../../theme';

export default function RecipeRunPage(props: { readonly params: Promise<{ id: string }> }) {
  const { id } = use(props.params);
  return (
    <main>
      <RecipeGraph recipeRunId={id} locale={theme.locale} />
    </main>
  );
}
