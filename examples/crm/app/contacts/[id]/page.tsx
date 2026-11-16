'use client';
import contact from '@/resources/contact';
import { ResourceDetailLoader } from '@indx-workspace/app/react';
import { use } from 'react';

export default function ContactPage(props: { readonly params: Promise<{ id: string }> }) {
  const { id } = use(props.params);
  return <ResourceDetailLoader resource={contact} id={id} editHref={`/contacts/${id}/edit`} />;
}
