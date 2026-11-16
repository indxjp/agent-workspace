import { RecipeRunPage } from '../../../components/recipe-pages';
import { localeOf } from '../../../components/words';
import type { ReactNode } from 'react';

export default async function RecipeRunRoute(props: {
  readonly params: Promise<{ readonly id: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { id } = await props.params;
  const { lang } = await props.searchParams;
  return <RecipeRunPage locale={localeOf(lang)} recipeRunId={id} />;
}
