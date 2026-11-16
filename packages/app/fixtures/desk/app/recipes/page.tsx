import { RecipeRunsPage } from '../../components/recipe-pages';
import { localeOf } from '../../components/words';
import type { ReactNode } from 'react';

export default async function RecipesPage(props: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { lang } = await props.searchParams;
  return <RecipeRunsPage locale={localeOf(lang)} />;
}
