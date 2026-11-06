'use client';
import note from '@/resources/note';
import { ResourceList } from '@indx-workspace/app/react';

export default function NotesPage() {
  return <ResourceList resource={note} />;
}
