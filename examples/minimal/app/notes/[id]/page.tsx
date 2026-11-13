'use client';
import note from '@/resources/note';
import { ResourceDetailLoader } from '@indx-workspace/app/react';
import { use } from 'react';

export default function NotePage(props: { readonly params: Promise<{ id: string }> }) {
  const { id } = use(props.params);
  return <ResourceDetailLoader resource={note} id={id} editHref={`/notes/${id}/edit`} />;
}
