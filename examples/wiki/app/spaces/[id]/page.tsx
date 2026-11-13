'use client';
import space from '@/resources/space';
import { ResourceDetailLoader } from '@indx-workspace/app/react';
import { use } from 'react';

export default function SpacePage(props: { readonly params: Promise<{ id: string }> }) {
  const { id } = use(props.params);
  return <ResourceDetailLoader resource={space} id={id} editHref={`/spaces/${id}/edit`} />;
}
