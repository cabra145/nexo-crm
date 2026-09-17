import type { Metadata } from 'next';
import { RegisterForm } from './register-form';

export const metadata: Metadata = { title: 'Crea tu empresa' };

export default function RegisterPage() {
  return <RegisterForm />;
}
