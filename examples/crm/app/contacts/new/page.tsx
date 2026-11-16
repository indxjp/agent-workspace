'use client';
import contact from '@/resources/contact';
import { ResourceForm } from '@indx-workspace/app/react';

export default function NewContactPage() {
  const saved = ({ id }: { readonly id: string }) => {
    window.location.assign(`/contacts/${id}`);
  };
  return <ResourceForm resource={contact} cancelHref="/contacts" onSaved={saved} />;
}
