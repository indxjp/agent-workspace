'use client';
import note from '@/resources/note';
import { ResourceFormLoader } from '@indx-workspace/app/react';
import { use } from 'react';

export default function EditNotePage(props: { readonly params: Promise<{ id: string }> }) {
  const { id } = use(props.params);
  const saved = () => window.location.assign(`/notes/${id}`);
  return <ResourceFormLoader resource={note} id={id} cancelHref={`/notes/${id}`} onSaved={saved} />;
}
