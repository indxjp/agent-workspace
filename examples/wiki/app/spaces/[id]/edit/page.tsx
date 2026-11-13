'use client';
import space from '@/resources/space';
import { ResourceFormLoader } from '@indx-workspace/app/react';
import { use } from 'react';

export default function EditSpacePage(props: { readonly params: Promise<{ id: string }> }) {
  const { id } = use(props.params);
  const saved = () => window.location.assign(`/spaces/${id}`);
  return <ResourceFormLoader resource={space} id={id} cancelHref={`/spaces/${id}`} onSaved={saved} />;
}
