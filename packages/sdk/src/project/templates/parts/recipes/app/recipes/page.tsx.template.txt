'use client';
import { RecipeRunList } from '@indx-workspace/app/react';

import { theme } from '../theme';

export default function RecipesPage() {
  return (
    <main>
      <RecipeRunList locale={theme.locale} />
    </main>
  );
}
