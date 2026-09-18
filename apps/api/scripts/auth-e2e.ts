/**
 * Prueba de extremo a extremo de la autenticación, contra la API REAL.
 *
 * Recorre el camino normal —registro, correo, verificación, sesión, 2FA,
 * recuperación— y, sobre todo, los ataques que la autenticación tiene que
 * resistir: robo de la cookie de refresco, CSRF, fuerza bruta, enumeración de
 * cuentas, reutilización de códigos y de enlaces.
 *
 * Necesita la API y el worker en marcha (los correos los envía el worker),
 * Mailpit, y el rol dueño de la base para manipular fechas y limpiar.
 * Crea sus propias cuentas y empresas, y las borra al terminar.
 *
 *   pnpm --filter @nexo/api auth:e2e
 */
import { createHash } from 'node:crypto';
import { AUTH_PROBLEMS, AUTH_TIMINGS, PROBLEM_TYPES, REFRESH_COOKIE } from '@nexo/contracts';
import { PrismaClient } from '@nexo/database';
import {
  APP_ORIGIN,
  check,
  http,
  section,
  summarize,
  tokenFrom,
  totpFor,
  waitForMail,
} from './lib/e2e';

const run = Date.now().toString(36);
const owner1 = {
  email: `e2e-${run}-a@nexo.test`,
  password: 'Contraseña-Segura-2026',
  name: 'Ana Prueba',
  companyName: `Pruebas E2E ${run}`,
};
const owner2 = {
  email: `e2e-${run}-b@nexo.test`,
  password: 'Otra-Clave-Segura-2026',
  name: 'Bruno Prueba',
  companyName: `Plazo 2FA ${run}`,
};

const sameProblem = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  a.type === b.type && a.title === b.title && a.detail === b.detail && a.status === b.status;

/* ========================================================================== */

async function main(): Promise<void> {
  const db = new PrismaClient({ datasourceUrl: process.env.DIRECT_DATABASE_URL });
  console.log(`\nAutenticación de extremo a extremo · ejecución ${run}`);

  try {
    /* ---------------------------------------------------------------------- */
    section('1 · Registro');
    const weak = await http('POST', '/auth/register', { body: { ...owner1, password: 'corta' } });
    check(
      'una contraseña débil se rechaza con el error en su campo',
      weak.status === 400 &&
        (weak.body.errors as Array<{ field: string }> | undefined)?.some(
          (e) => e.field === 'password',
        ) === true,
      `${weak.status}`,
    );

    const reg = await http('POST', '/auth/register', { body: owner1 });
    check('el registro se acepta', reg.status === 202, `${reg.status}`);

    const verifyText = await waitForMail(owner1.email, 'Confirma tu correo');
    const verifyToken = tokenFrom(verifyText);
    check('llega el correo de confirmación, con enlace', Boolean(verifyToken));
    // Sin ese enlace no hay prueba que seguir, y continuar sólo produce
    // errores posteriores que esconden la causa (pasó una vez: un TypeError
    // sobre un campo ausente en vez de «no llegó el correo»).
    if (!verifyToken) {
      throw new Error(
        'No llegó el correo de confirmación. Mira el log del worker y la cola "email": ' +
          'suele ser que el worker no procesó el trabajo o que Mailpit no estaba listo.',
      );
    }

    const early = await http('POST', '/auth/login', {
      body: { email: owner1.email, password: owner1.password },
    });
    check(
      'sin confirmar el correo no se puede entrar',
      early.status === 403 && early.body.type === AUTH_PROBLEMS.EMAIL_NOT_VERIFIED,
      `${early.status}`,
    );

    const dup = await http('POST', '/auth/register', {
      body: { ...owner1, name: 'Intruso', companyName: 'Otra' },
    });
    check(
      'registrar un correo existente responde EXACTAMENTE igual (no revela la cuenta)',
      dup.status === reg.status && JSON.stringify(dup.body) === JSON.stringify(reg.body),
    );
    check(
      '…y al dueño le llega un aviso por correo',
      Boolean(await waitForMail(owner1.email, 'Ya tienes una cuenta')),
    );

    /* ---------------------------------------------------------------------- */
    section('2 · Verificación de correo');
    const bogus = await http('POST', '/auth/verify-email', { body: { token: 'x'.repeat(43) } });
    check(
      'un enlace inventado no sirve',
      bogus.status === 400 && bogus.body.type === AUTH_PROBLEMS.TOKEN_INVALID,
    );
    const verified = await http('POST', '/auth/verify-email', { body: { token: verifyToken } });
    check('el enlace confirma el correo', verified.status === 200, `${verified.status}`);
    const reused = await http('POST', '/auth/verify-email', { body: { token: verifyToken } });
    check('el mismo enlace no sirve dos veces', reused.status === 400);

    /* ---------------------------------------------------------------------- */
    section('3 · Inicio de sesión');
    const wrongPass = await http('POST', '/auth/login', {
      body: { email: owner1.email, password: 'Incorrecta-123456' },
    });
    const noAccount = await http('POST', '/auth/login', {
      body: { email: `nadie-${run}@nexo.test`, password: 'Incorrecta-123456' },
    });
    check(
      'contraseña mala → 401',
      wrongPass.status === 401 && wrongPass.body.type === AUTH_PROBLEMS.INVALID_CREDENTIALS,
    );
    check(
      'correo sin cuenta → la MISMA respuesta que contraseña mala',
      noAccount.status === 401 && sameProblem(wrongPass.body, noAccount.body),
    );

    const login = await http<{
      accessToken: string;
      activeTenant: { role: string; tenantSlug: string; tenantId: string };
      twoFactor: { required: boolean; blocked: boolean; deadline: string };
    }>('POST', '/auth/login', { body: { email: owner1.email, password: owner1.password } });
    check(
      'con el correo confirmado, entra',
      login.status === 200 && Boolean(login.body.accessToken),
      `${login.status}`,
    );
    const cookieAttrs = login.setCookieRaw.find((c) => c.startsWith(`${REFRESH_COOKIE}=`)) ?? '';
    check(
      'la cookie de refresco es HttpOnly, SameSite=Lax y sólo para /api/v1/auth',
      /HttpOnly/i.test(cookieAttrs) &&
        /SameSite=Lax/i.test(cookieAttrs) &&
        /Path=\/api\/v1\/auth/i.test(cookieAttrs),
    );
    check(
      'el token de acceso NO va en una cookie',
      !login.setCookieRaw.some((c) => c.includes(login.body.accessToken)),
    );
    const days = (new Date(login.body.twoFactor.deadline).getTime() - Date.now()) / 86_400_000;
    check(
      'es propietario, con 2FA obligatorio y 7 días de plazo',
      login.body.activeTenant.role === 'OWNER' &&
        login.body.twoFactor.required &&
        !login.body.twoFactor.blocked &&
        days > 6.9 &&
        days <= 7,
      `${days.toFixed(2)} días`,
    );

    const access = login.body.accessToken;
    let cookie = login.refreshCookie;
    const tenantId = login.body.activeTenant.tenantId;

    const me = await http('GET', '/auth/me', { token: access });
    const anon = await http('GET', '/auth/me');
    check('/auth/me con sesión → 200; sin sesión → 401', me.status === 200 && anon.status === 401);
    const tenant = await http<{ slug: string }>('GET', '/tenant', { token: access });
    check(
      'la empresa activa se lee con RLS',
      tenant.status === 200 && tenant.body.slug === login.body.activeTenant.tenantSlug,
      tenant.body.slug,
    );

    const [roles, stages] = await Promise.all([
      db.role.count({ where: { tenantId } }),
      db.pipelineStage.count({ where: { tenantId } }),
    ]);
    check(
      'la empresa nace con sus 5 roles y las 7 etapas del embudo',
      roles === 5 && stages === 7,
      `${roles} roles, ${stages} etapas`,
    );

    /* ---------------------------------------------------------------------- */
    section('4 · Renovación de la sesión y robo de la cookie');
    const noHeader = await http('POST', '/auth/refresh', { cookie });
    check('sin la cabecera del cliente web → 403 (CSRF)', noHeader.status === 403);
    const evil = await http('POST', '/auth/refresh', {
      cookie,
      client: true,
      origin: 'https://sitio-malicioso.example',
    });
    check('desde otro origen → 403 (CSRF)', evil.status === 403);
    const own = await http('POST', '/auth/refresh', { cookie, client: true, origin: APP_ORIGIN });
    check(
      'desde la web, con la cabecera → sesión nueva',
      own.status === 200 && Boolean(own.refreshCookie) && own.refreshCookie !== cookie,
    );

    const refresh = (c: string | null, userAgent?: string) =>
      http('POST', '/auth/refresh', { cookie: c, client: true, userAgent });
    const loginFresh = async () =>
      (
        await http('POST', '/auth/login', {
          body: { email: owner1.email, password: owner1.password },
        })
      ).refreshCookie;

    // Respuesta perdida: la API canjeó `cookie` y emitió `own.refreshCookie`,
    // pero el navegador no recibió la respuesta (recarga, corte de red) y
    // vuelve a presentar la cookie anterior. No es un robo.
    const lost = cookie;
    const retry = await refresh(lost);
    check(
      'respuesta perdida: la cookie anterior, reintentada al momento desde el mismo navegador → sesión nueva',
      retry.status === 200 && Boolean(retry.refreshCookie),
    );
    const firstStillValid = await refresh(own.refreshCookie);
    check(
      '…y el token que se perdió por el camino sigue sirviendo',
      firstStillValid.status === 200,
    );

    // Robo 1: la cadena ya avanzó (el navegador legítimo usó el sucesor).
    const afterAdvance = await refresh(lost);
    check(
      'reusar la cookie anterior cuando la cadena ya avanzó (robo) → 401',
      afterAdvance.status === 401,
    );
    const legitAfterTheft = await refresh(firstStillValid.refreshCookie);
    check(
      '…y la sesión LEGÍTIMA también queda revocada (familia entera)',
      legitAfterTheft.status === 401,
    );

    // Robo 2: otro navegador, aunque sea dentro del margen.
    let stolen = await loginFresh();
    const legit2 = await refresh(stolen);
    const otherBrowser = await refresh(stolen, 'Mozilla/5.0 (Atacante)');
    check('reusar la cookie desde otro navegador, al momento → 401', otherBrowser.status === 401);
    check('…y revoca la familia', (await refresh(legit2.refreshCookie)).status === 401);

    // Robo 3: fuera del margen de reintento.
    stolen = await loginFresh();
    const legit3 = await refresh(stolen);
    await db.refreshToken.update({
      where: {
        tokenHash: createHash('sha256')
          .update(stolen ?? '')
          .digest('hex'),
      },
      data: {
        usedAt: new Date(Date.now() - (AUTH_TIMINGS.refreshRetryGraceSeconds + 5) * 1000),
      },
    });
    const afterGrace = await refresh(stolen);
    check(
      `reusar la cookie pasados ${AUTH_TIMINGS.refreshRetryGraceSeconds} s, desde el mismo navegador → 401`,
      afterGrace.status === 401,
    );
    check('…y revoca la familia', (await refresh(legit3.refreshCookie)).status === 401);

    // Tope: el margen no sirve para fabricar sesiones.
    stolen = await loginFresh();
    await refresh(stolen);
    const siblings: number[] = [];
    for (let i = 0; i < 3; i++) siblings.push((await refresh(stolen)).status);
    check(
      'reintentos dentro del margen: como mucho 3 tokens sin usar; el siguiente → 401',
      siblings.join(',') === '200,200,401',
      siblings.join(','),
    );

    /* ---------------------------------------------------------------------- */
    section('5 · Cambio de empresa');
    const relog = await http<{ accessToken: string }>('POST', '/auth/login', {
      body: { email: owner1.email, password: owner1.password },
    });
    cookie = relog.refreshCookie;
    const acme = await db.tenant.findUnique({ where: { slug: 'acme' } });
    const foreign = await http('POST', '/auth/switch-tenant', {
      token: relog.body.accessToken,
      cookie,
      client: true,
      body: { tenantId: acme?.id },
    });
    check(
      'cambiar a una empresa ajena → 403',
      foreign.status === 403 && foreign.body.type === AUTH_PROBLEMS.TENANT_UNAVAILABLE,
    );
    const stillValid = await http('POST', '/auth/refresh', { cookie, client: true });
    check('…sin perder la sesión propia por haberlo intentado', stillValid.status === 200);
    cookie = stillValid.refreshCookie;

    /* ---------------------------------------------------------------------- */
    section('6 · Verificación en dos pasos');
    const session = await http<{ accessToken: string }>('POST', '/auth/refresh', {
      cookie,
      client: true,
    });
    cookie = session.refreshCookie;
    const setup = await http<{ secret: string; otpauthUrl: string }>('POST', '/auth/2fa/setup', {
      token: session.body.accessToken,
    });
    check(
      'genera el secreto y la URL para el QR',
      setup.status === 200 &&
        setup.body.otpauthUrl.startsWith('otpauth://totp/') &&
        setup.body.secret.length >= 32,
    );

    const badEnable = await http('POST', '/auth/2fa/enable', {
      token: session.body.accessToken,
      cookie,
      client: true,
      body: { code: '000000' },
    });
    check('activarlo con un código incorrecto → 401', badEnable.status === 401);
    const enableCode = totpFor(setup.body.secret);
    const enabled = await http<{
      recoveryCodes: string[];
      session: { twoFactor: { enabled: boolean } };
    }>('POST', '/auth/2fa/enable', {
      token: session.body.accessToken,
      cookie,
      client: true,
      body: { code: enableCode },
    });
    check(
      'con el código correcto se activa y entrega 10 códigos de recuperación',
      enabled.status === 200 &&
        enabled.body.recoveryCodes?.length === 10 &&
        enabled.body.session.twoFactor.enabled,
      `${enabled.status}`,
    );
    const preTwoFactorCookie = cookie;
    cookie = enabled.refreshCookie;
    check(
      'las sesiones abiertas sin 2FA se cierran',
      (await http('POST', '/auth/refresh', { cookie: preTwoFactorCookie, client: true })).status ===
        401,
    );
    check('se avisa por correo', Boolean(await waitForMail(owner1.email, 'dos pasos activado')));

    const step1 = await http<{ requiresTwoFactor: boolean; challengeToken: string }>(
      'POST',
      '/auth/login',
      { body: { email: owner1.email, password: owner1.password } },
    );
    check(
      'ahora la contraseña sola no basta: pide el segundo factor, sin dar sesión',
      step1.status === 200 && step1.body.requiresTwoFactor === true && !step1.refreshCookie,
    );

    const replayCode = await http('POST', '/auth/login/2fa', {
      body: { challengeToken: step1.body.challengeToken, code: enableCode },
    });
    check(
      'el código ya usado para activarlo no sirve otra vez (antirreproducción)',
      replayCode.status === 401,
    );
    const nextCode = totpFor(setup.body.secret, 1);
    const step2 = await http<{ accessToken: string }>('POST', '/auth/login/2fa', {
      body: { challengeToken: step1.body.challengeToken, code: nextCode },
    });
    check(
      'con un código válido entra',
      step2.status === 200 && Boolean(step2.body.accessToken),
      `${step2.status}`,
    );
    const challengeReuse = await http('POST', '/auth/login/2fa', {
      body: { challengeToken: step1.body.challengeToken, code: totpFor(setup.body.secret, -1) },
    });
    check(
      'el mismo desafío no sirve para un segundo inicio de sesión',
      challengeReuse.status === 401,
    );

    const recovery = enabled.body.recoveryCodes[0]!;
    const c1 = await http<{ challengeToken: string }>('POST', '/auth/login', {
      body: { email: owner1.email, password: owner1.password },
    });
    const withRecovery = await http('POST', '/auth/login/2fa', {
      body: { challengeToken: c1.body.challengeToken, recoveryCode: recovery },
    });
    check(
      'un código de recuperación permite entrar',
      withRecovery.status === 200,
      `${withRecovery.status}`,
    );
    const c2 = await http<{ challengeToken: string }>('POST', '/auth/login', {
      body: { email: owner1.email, password: owner1.password },
    });
    const recoveryAgain = await http('POST', '/auth/login/2fa', {
      body: { challengeToken: c2.body.challengeToken, recoveryCode: recovery },
    });
    check('…pero una sola vez', recoveryAgain.status === 401);

    /* ---------------------------------------------------------------------- */
    section('7 · Plazo del 2FA obligatorio del propietario');
    await http('POST', '/auth/register', { body: owner2 });
    const token2 = tokenFrom(await waitForMail(owner2.email, 'Confirma tu correo'));
    await http('POST', '/auth/verify-email', { body: { token: token2 } });
    const user2 = await db.user.findUniqueOrThrow({ where: { email: owner2.email } });
    // Se simula que entró hace 8 días: el plazo de 7 venció.
    await db.membership.updateMany({
      where: { userId: user2.id },
      data: { acceptedAt: new Date(Date.now() - 8 * 86_400_000) },
    });
    const late = await http<{ accessToken: string; twoFactor: { blocked: boolean } }>(
      'POST',
      '/auth/login',
      { body: { email: owner2.email, password: owner2.password } },
    );
    check(
      'pasado el plazo, la sesión indica que está bloqueado',
      late.status === 200 && late.body.twoFactor.blocked,
    );
    const blockedRoute = await http('GET', '/tenant', { token: late.body.accessToken });
    check(
      '…y el producto responde 403 hasta activar el 2FA',
      blockedRoute.status === 403 && blockedRoute.body.type === AUTH_PROBLEMS.TWO_FACTOR_REQUIRED,
    );
    const allowedRoute = await http('POST', '/auth/2fa/setup', { token: late.body.accessToken });
    check('…pero puede configurar el 2FA', allowedRoute.status === 200);

    /* ---------------------------------------------------------------------- */
    section('8 · Recuperación de contraseña');
    const unknownForgot = await http('POST', '/auth/password/forgot', {
      body: { email: `nadie-${run}@nexo.test` },
    });
    const knownForgot = await http('POST', '/auth/password/forgot', {
      body: { email: owner2.email },
    });
    check(
      'pedirla para un correo sin cuenta responde igual que para uno con cuenta',
      unknownForgot.status === 202 &&
        JSON.stringify(unknownForgot.body) === JSON.stringify(knownForgot.body),
    );
    const resetToken = tokenFrom(await waitForMail(owner2.email, 'Restablece tu contraseña'));
    check('llega el enlace', Boolean(resetToken));

    const cookieBeforeReset = late.refreshCookie;
    const weakReset = await http('POST', '/auth/password/reset', {
      body: { token: resetToken, password: 'corta' },
    });
    check('no acepta una contraseña débil', weakReset.status === 400);
    const newPassword = 'Clave-Renovada-2026';
    const reset = await http('POST', '/auth/password/reset', {
      body: { token: resetToken, password: newPassword },
    });
    check('cambia la contraseña', reset.status === 200, `${reset.status}`);
    check(
      'el enlace no sirve dos veces',
      (
        await http('POST', '/auth/password/reset', {
          body: { token: resetToken, password: 'Otra-Clave-2026-x' },
        })
      ).status === 400,
    );
    check(
      'la contraseña anterior ya no entra',
      (
        await http('POST', '/auth/login', {
          body: { email: owner2.email, password: owner2.password },
        })
      ).status === 401,
    );
    check(
      'la nueva sí',
      (await http('POST', '/auth/login', { body: { email: owner2.email, password: newPassword } }))
        .status === 200,
    );
    check(
      'las sesiones anteriores al cambio quedan cerradas',
      (await http('POST', '/auth/refresh', { cookie: cookieBeforeReset, client: true })).status ===
        401,
    );

    /* ---------------------------------------------------------------------- */
    section('9 · Fuerza bruta');
    for (let i = 0; i < 5; i++) {
      await http('POST', '/auth/login', {
        body: { email: owner2.email, password: `Mala-${i}-1234567` },
      });
    }
    const locked = await http('POST', '/auth/login', {
      body: { email: owner2.email, password: newPassword },
    });
    check(
      'tras 5 fallos, ni la contraseña correcta entra: 429 con Retry-After',
      locked.status === 429 &&
        locked.body.type === PROBLEM_TYPES.RATE_LIMITED &&
        Number(locked.headers.get('retry-after')) > 0,
      `${locked.status}, Retry-After ${locked.headers.get('retry-after')}`,
    );

    /* ---------------------------------------------------------------------- */
    section('10 · Cierre de sesión');
    const lo = await http<{ accessToken: string }>('POST', '/auth/login/2fa', {
      body: {
        challengeToken: (
          await http<{ challengeToken: string }>('POST', '/auth/login', {
            body: { email: owner1.email, password: owner1.password },
          })
        ).body.challengeToken,
        recoveryCode: enabled.body.recoveryCodes[1],
      },
    });
    const logout = await http('POST', '/auth/logout', { cookie: lo.refreshCookie, client: true });
    check(
      'cerrar sesión borra la cookie',
      logout.status === 204 && logout.setCookieRaw.some((c) => c.startsWith(`${REFRESH_COOKIE}=;`)),
    );
    check(
      'esa cookie ya no renueva nada',
      (await http('POST', '/auth/refresh', { cookie: lo.refreshCookie, client: true })).status ===
        401,
    );

    /* ---------------------------------------------------------------------- */
    section('11 · Auditoría (escrita por el worker)');
    const wanted = ['CREATE', 'LOGIN', 'TWO_FACTOR_ENABLE'];
    let actions: string[] = [];
    for (let i = 0; i < 30 && !wanted.every((a) => actions.includes(a)); i++) {
      actions = (await db.auditLog.findMany({ where: { tenantId }, select: { action: true } })).map(
        (a) => a.action,
      );
      await new Promise((r) => setTimeout(r, 300));
    }
    for (const action of wanted) check(`queda registrado ${action}`, actions.includes(action));
    const user2Tenant = await db.membership.findFirst({
      where: { userId: user2.id },
      select: { tenantId: true },
    });
    const pwd = user2Tenant
      ? await db.auditLog.count({
          where: { tenantId: user2Tenant.tenantId, action: 'PASSWORD_CHANGE' },
        })
      : 0;
    check('queda registrado PASSWORD_CHANGE', pwd > 0);
  } finally {
    // Limpieza: las empresas se borran en cascada con todo lo suyo.
    const users = await db.user.findMany({
      where: { email: { in: [owner1.email, owner2.email] } },
      select: { id: true },
    });
    const memberships = await db.membership.findMany({
      where: { userId: { in: users.map((u) => u.id) } },
      select: { tenantId: true },
    });
    await db.tenant.deleteMany({ where: { id: { in: memberships.map((m) => m.tenantId) } } });
    await db.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
    await db.$disconnect();
  }

  summarize('Autenticación verificada de extremo a extremo.');
}

main()
  .catch((error: unknown) => {
    console.error('\nLa prueba no pudo completarse:\n', error);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
