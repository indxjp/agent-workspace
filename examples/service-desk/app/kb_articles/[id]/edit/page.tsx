'use client';
import kb_article from '@/resources/kb_article';
import { ResourceFormLoader } from '@indx-workspace/app/react';
import { use } from 'react';

export default function EditKbArticlePage(props: { readonly params: Promise<{ id: string }> }) {
  const { id } = use(props.params);
  const saved = () => window.location.assign(`/kb_articles/${id}`);
  return <ResourceFormLoader resource={kb_article} id={id} cancelHref={`/kb_articles/${id}`} onSaved={saved} />;
}
