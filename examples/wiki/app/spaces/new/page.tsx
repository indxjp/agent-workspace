'use client';
import space from '@/resources/space';
import { ResourceForm } from '@indx-workspace/app/react';

export default function NewSpacePage() {
  const saved = ({ id }: { readonly id: string }) => {
    window.location.assign(`/spaces/${id}`);
  };
  return <ResourceForm resource={space} cancelHref="/spaces" onSaved={saved} />;
}
