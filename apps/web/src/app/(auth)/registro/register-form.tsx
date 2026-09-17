'use client';

import { registerSchema, toSlug } from '@nexo/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { AuthShell } from '@/components/auth/auth-shell';
import { PasswordInput, PasswordRules } from '@/components/auth/password-field';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/api/client';
import { authApi } from '@/lib/auth/api';

/** Clave con la que la pantalla siguiente recupera el correo, sin ponerlo en la URL. */
export const REGISTERED_EMAIL_KEY = 'nexo:registro:correo';

type Fields = 'name' | 'email' | 'companyName' | 'slug' | 'password';

export function RegisterForm() {
  const router = useRouter();
  const [values, setValues] = useState({ name: '', email: '', companyName: '', password: '' });
  const [customSlug, setCustomSlug] = useState<string | null>(null);
  const [errors, setErrors] = useState<Partial<Record<Fields, string>>>({});
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  const slug = customSlug ?? toSlug(values.companyName);
  const set = (field: keyof typeof values) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [field]: e.target.value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    const parsed = registerSchema.safeParse({ ...values, slug: slug || undefined });
    if (!parsed.success) {
      const next: Partial<Record<Fields, string>> = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] as Fields;
        next[field] ??= issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});

    setPending(true);
    try {
      await authApi.register(parsed.data);
      // sessionStorage y no la URL: un correo en la URL queda en el historial,
      // en los registros del servidor y en la cabecera Referer.
      sessionStorage.setItem(REGISTERED_EMAIL_KEY, parsed.data.email);
      router.push('/registro/revisa-tu-correo');
    } catch (err) {
      if (err instanceof ApiError && err.fieldError('slug')) {
        setErrors({ slug: err.problem.detail ?? 'Esa dirección ya está en uso' });
      } else {
        setError(err);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthShell
      title="Crea el espacio de tu empresa"
      description="14 días de prueba. Sin tarjeta."
      footer={
        <>
          ¿Ya tienes cuenta?{' '}
          <Link
            href="/login"
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            Inicia sesión
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="grid gap-5" noValidate>
        <ProblemAlert error={error} />

        <Field label="Tu nombre" error={errors.name}>
          {(a) => (
            <Input
              {...a}
              autoComplete="name"
              autoFocus
              value={values.name}
              onChange={set('name')}
            />
          )}
        </Field>

        <Field label="Correo de trabajo" error={errors.email}>
          {(a) => (
            <Input
              {...a}
              type="email"
              autoComplete="email"
              value={values.email}
              onChange={set('email')}
            />
          )}
        </Field>

        <Field
          label="Nombre de la empresa"
          error={errors.companyName ?? errors.slug}
          hint={
            slug ? (
              <span>
                Tu espacio estará en <span className="font-mono text-fg">/w/{slug}</span>
                {customSlug === null ? (
                  <>
                    {' · '}
                    <button
                      type="button"
                      className="underline underline-offset-4 hover:text-fg"
                      onClick={() => setCustomSlug(slug)}
                    >
                      Cambiar
                    </button>
                  </>
                ) : null}
              </span>
            ) : undefined
          }
        >
          {(a) => (
            <Input
              {...a}
              autoComplete="organization"
              value={values.companyName}
              onChange={set('companyName')}
            />
          )}
        </Field>

        {customSlug !== null ? (
          <Field label="Dirección del espacio" hint="Minúsculas, números y guiones.">
            {(a) => (
              <div className="flex items-center rounded-md border border-border-strong bg-surface-sunken focus-within:border-primary">
                <span className="pl-3 font-mono text-sm text-fg-faint">/w/</span>
                <Input
                  {...a}
                  value={customSlug}
                  onChange={(e) =>
                    setCustomSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
                  }
                  className="border-0 bg-transparent pl-0.5 font-mono focus-visible:ring-0"
                />
              </div>
            )}
          </Field>
        ) : null}

        <Field label="Contraseña" error={errors.password}>
          {(a) => (
            <div className="grid gap-1">
              <PasswordInput
                {...a}
                autoComplete="new-password"
                value={values.password}
                onChange={set('password')}
              />
              <PasswordRules value={values.password} />
            </div>
          )}
        </Field>

        <Button type="submit" size="lg" disabled={pending}>
          {pending ? 'Creando tu espacio…' : 'Crear mi empresa'}
        </Button>

        <p className="text-center text-xs text-fg-faint">
          Al continuar aceptas los términos del servicio y la política de privacidad.
        </p>
      </form>
    </AuthShell>
  );
}
