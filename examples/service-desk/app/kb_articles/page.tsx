'use client';
import kb_article from '@/resources/kb_article';
import { ResourceList } from '@indx-workspace/app/react';

export default function KbArticlesPage() {
  return <ResourceList resource={kb_article} />;
}
