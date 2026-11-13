'use client';
import kb_article from '@/resources/kb_article';
import { ResourceForm } from '@indx-workspace/app/react';

export default function NewKbArticlePage() {
  const saved = ({ id }: { readonly id: string }) => {
    window.location.assign(`/kb_articles/${id}`);
  };
  return <ResourceForm resource={kb_article} cancelHref="/kb_articles" onSaved={saved} />;
}
