import type { Metadata } from 'next';
import { ForgotForm } from './forgot-form';

export const metadata: Metadata = { title: 'Recuperar contraseña' };

export default function ForgotPage() {
  return <ForgotForm />;
}
