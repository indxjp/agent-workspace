'use client';
import company from '@/resources/company';
import { ResourceDetailLoader } from '@indx-workspace/app/react';
import { use } from 'react';

export default function CompanyPage(props: { readonly params: Promise<{ id: string }> }) {
  const { id } = use(props.params);
  return <ResourceDetailLoader resource={company} id={id} editHref={`/companys/${id}/edit`} />;
}
