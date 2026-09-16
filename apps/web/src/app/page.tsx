import { redirect } from 'next/navigation';

/**
 * Raíz del producto.
 *
 * Hasta la Fase 1 lleva al estado del sistema. Con la autenticación, llevará
 * al espacio de trabajo del usuario si tiene sesión, o al inicio de sesión si
 * no la tiene.
 */
export default function Home() {
  redirect('/estado');
}
