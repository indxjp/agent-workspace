'use client';
import note from '@/resources/note';
import { ResourceForm } from '@indx-workspace/app/react';

export default function NewNotePage() {
  const saved = ({ id }: { readonly id: string }) => {
    window.location.assign(`/notes/${id}`);
  };
  return <ResourceForm resource={note} cancelHref="/notes" onSaved={saved} />;
}
