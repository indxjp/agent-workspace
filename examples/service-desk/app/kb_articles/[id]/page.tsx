'use client';
import kb_article from '@/resources/kb_article';
import { ResourceDetailLoader } from '@indx-workspace/app/react';
import { use } from 'react';

export default function KbArticlePage(props: { readonly params: Promise<{ id: string }> }) {
  const { id } = use(props.params);
  return <ResourceDetailLoader resource={kb_article} id={id} editHref={`/kb_articles/${id}/edit`} />;
}
