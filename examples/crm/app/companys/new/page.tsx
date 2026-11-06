'use client';
import company from '@/resources/company';
import { ResourceForm } from '@indx-workspace/app/react';

export default function NewCompanyPage() {
  const saved = ({ id }: { readonly id: string }) => {
    window.location.assign(`/companys/${id}`);
  };
  return <ResourceForm resource={company} cancelHref="/companys" onSaved={saved} />;
}
