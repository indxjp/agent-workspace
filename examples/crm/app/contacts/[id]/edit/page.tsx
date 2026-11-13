'use client';
import contact from '@/resources/contact';
import { ResourceFormLoader } from '@indx-workspace/app/react';
import { use } from 'react';

export default function EditContactPage(props: { readonly params: Promise<{ id: string }> }) {
  const { id } = use(props.params);
  const saved = () => window.location.assign(`/contacts/${id}`);
  return <ResourceFormLoader resource={contact} id={id} cancelHref={`/contacts/${id}`} onSaved={saved} />;
}
