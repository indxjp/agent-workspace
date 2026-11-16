'use client';
import company from '@/resources/company';
import { ResourceFormLoader } from '@indx-workspace/app/react';
import { use } from 'react';

export default function EditCompanyPage(props: { readonly params: Promise<{ id: string }> }) {
  const { id } = use(props.params);
  const saved = () => window.location.assign(`/companys/${id}`);
  return <ResourceFormLoader resource={company} id={id} cancelHref={`/companys/${id}`} onSaved={saved} />;
}
