import type { Metadata } from 'next';
import { CheckEmail } from './check-email';

export const metadata: Metadata = { title: 'Revisa tu correo' };

export default function CheckEmailPage() {
  return <CheckEmail />;
}
