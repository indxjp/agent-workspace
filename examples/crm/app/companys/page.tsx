'use client';
import company from '@/resources/company';
import { ResourceList } from '@indx-workspace/app/react';

export default function CompanysPage() {
  return <ResourceList resource={company} />;
}
