'use client';
import deal from '@/resources/deal';
import { ResourceForm } from '@indx-workspace/app/react';

export default function NewDealPage() {
  const saved = ({ id }: { readonly id: string }) => {
    window.location.assign(`/deals/${id}`);
  };
  return <ResourceForm resource={deal} cancelHref="/deals" onSaved={saved} />;
}
