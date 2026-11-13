import { redirect } from 'next/navigation';

// The service desk opens on its dashboard: the runs, approvals, failures and spend of the desk.
export default function HomePage(): never {
  redirect('/dashboard');
}
