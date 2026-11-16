'use client';
import deal from '@/resources/deal';
import { ResourceFormLoader } from '@indx-workspace/app/react';
import { use } from 'react';

export default function EditDealPage(props: { readonly params: Promise<{ id: string }> }) {
  const { id } = use(props.params);
  const saved = () => window.location.assign(`/deals/${id}`);
  return <ResourceFormLoader resource={deal} id={id} cancelHref={`/deals/${id}`} onSaved={saved} />;
}
