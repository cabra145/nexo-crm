/**
 * Prueba de extremo a extremo del equipo y los permisos, contra la API REAL.
 *
 * Crea una empresa, invita a un miembro de cada rol (con cuenta nueva y con
 * cuenta existente), y comprueba lo que cada uno puede y NO puede hacer:
 * permisos por rol, escalada de privilegios, protección del propietario,
 * efecto inmediato de desactivar o cambiar un rol, plazas del plan (también
 * con invitaciones simultáneas), roles personalizados, transferencia de la
 * propiedad y aislamiento entre empresas.
 *
 * Necesita API, worker y Mailpit en marcha, y el rol dueño de la base para
 * cambiar el plan y limpiar. Crea sus propias empresas y las borra al terminar.
 *
 *   pnpm --filter @nexo/api rbac:e2e
 */
import { TEAM_PROBLEMS } from '@nexo/contracts';
import { PrismaClient } from '@nexo/database';
import { currentStep } from '../src/auth/totp';
import {
  check,
  http,
  type HttpResult,
  section,
  summarize,
  tokenFrom,
  totpFor,
  waitForMail,
} from './lib/e2e';

const run = Date.now().toString(36);
const PASSWORD = 'Equipo-Seguro-2026';
const email = (who: string) => `rbac-${run}-${who}@nexo.test`;

interface Session {
  accessToken: string;
  cookie: string | null;
  userId: string;
  membershipId: string;
  tenantId: string;
}

type Body = Record<string, unknown>;

const sessionFrom = (res: HttpResult): Session => {
  const body = res.body as {
    accessToken: string;
    user: { id: string };
    activeTenant: { membershipId: string; tenantId: string };
  };
  return {
    accessToken: body.accessToken,
    cookie: res.refreshCookie,
    userId: body.user.id,
    membershipId: body.activeTenant.membershipId,
    tenantId: body.activeTenant.tenantId,
  };
};

const as = (s: Session) => ({ token: s.accessToken });

/** Espera al siguiente intervalo TOTP: la API no acepta el mismo dos veces. */
async function nextStep(after: number): Promise<void> {
  while (currentStep() <= after || 30_000 - (Date.now() % 30_000) < 3_000) {
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function main(): Promise<void> {
  const db = new PrismaClient({ datasourceUrl: process.env.DIRECT_DATABASE_URL });
  console.log(`\nEquipo y permisos de extremo a extremo · ejecución ${run}`);
  const tenantIds: string[] = [];

  /** Alta completa: registro, correo, verificación e inicio de sesión. */
  async function registerOwner(who: string, company: string): Promise<Session> {
    await http('POST', '/auth/register', {
      body: { name: `Dueño ${who}`, email: email(who), password: PASSWORD, companyName: company },
    });
    const token = tokenFrom(await waitForMail(email(who), 'Confirma tu correo'));
    await http('POST', '/auth/verify-email', { body: { token } });
    const login = await http('POST', '/auth/login', {
      body: { email: email(who), password: PASSWORD },
    });
    const session = sessionFrom(login);
    tenantIds.push(session.tenantId);
    return session;
  }

  /** Invita y devuelve el id de la membresía y el token del correo. */
  async function invite(
    by: Session,
    who: string,
    roleId: string,
    teamName?: string,
  ): Promise<{ res: HttpResult; membershipId: string; token: string | null }> {
    const res = await http('POST', '/team/invitations', {
      ...as(by),
      body: { email: email(who), roleId, teamName },
    });
    const token =
      res.status === 200 || res.status === 201
        ? tokenFrom(await waitForMail(email(who), 'te invita'))
        : null;
    return { res, membershipId: res.body.membershipId as string, token };
  }

  async function acceptNew(who: string, token: string | null): Promise<Session> {
    const res = await http('POST', '/invitations/accept-new', {
      body: { token, name: `Miembro ${who}`, password: PASSWORD },
    });
    if (res.status !== 200)
      throw new Error(`accept-new ${who} → ${res.status} ${JSON.stringify(res.body)}`);
    return sessionFrom(res);
  }

  async function enableTwoFactor(
    s: Session,
  ): Promise<{ session: Session; secret: string; step: number }> {
    const setup = await http<{ secret: string }>('POST', '/auth/2fa/setup', as(s));
    const step = currentStep();
    const enabled = await http<{ session: Body }>('POST', '/auth/2fa/enable', {
      ...as(s),
      cookie: s.cookie,
      client: true,
      body: { code: totpFor(setup.body.secret) },
    });
    const session = sessionFrom({ ...enabled, body: enabled.body.session });
    return { session, secret: setup.body.secret, step };
  }

  try {
    /* ---------------------------------------------------------------------- */
    section('1 · Empresa y acceso del propietario');
    let owner = await registerOwner('owner', `Equipo ${run}`);
    const tenantId = owner.tenantId;

    const ownerAccess = await http<{ role: { key: string }; permissions: Body }>(
      'GET',
      '/access',
      as(owner),
    );
    check(
      'GET /access → propietario, con todos los permisos',
      ownerAccess.status === 200 &&
        ownerAccess.body.role.key === 'OWNER' &&
        ownerAccess.body.permissions['billing:manage'] === 'ALL',
    );

    const rolesRes = await http<{
      roles: Array<{ id: string; key: string; name: string }>;
      customRolesEnabled: boolean;
    }>('GET', '/team/roles', as(owner));
    const roleId = (key: string) => rolesRes.body.roles.find((r) => r.key === key)!.id;
    check(
      'los cinco roles del sistema; el plan inicial no incluye roles personalizados',
      rolesRes.body.roles.filter((r) => r.key !== 'CUSTOM').length === 5 &&
        !rolesRes.body.customRolesEnabled,
    );

    const noCustom = await http('POST', '/team/roles', {
      ...as(owner),
      body: { name: 'Pruebas', permissions: { 'contact:read': 'ALL' } },
    });
    check(
      'crear un rol personalizado sin plan que lo incluya → 403',
      noCustom.status === 403 && noCustom.body.type === TEAM_PROBLEMS.FEATURE_UNAVAILABLE,
      `${noCustom.status}`,
    );

    /* ---------------------------------------------------------------------- */
    section('2 · Invitaciones con cuenta nueva');
    const asOwnerRole = await http('POST', '/team/invitations', {
      ...as(owner),
      body: { email: email('x'), roleId: roleId('OWNER') },
    });
    check(
      'invitar como propietario → 403 (sólo se transfiere)',
      asOwnerRole.status === 403 && asOwnerRole.body.type === TEAM_PROBLEMS.OWNER_PROTECTED,
    );

    const adminInv = await invite(owner, 'admin', roleId('ADMIN'));
    check(
      'invitar a un administrador → 201 y llega el correo',
      adminInv.res.status === 201 && Boolean(adminInv.token),
      `${adminInv.res.status}`,
    );

    const preview = await http<{
      tenantName: string;
      roleName: string;
      accountExists: boolean;
      inviterName: string;
    }>('POST', '/invitations/preview', { body: { token: adminInv.token } });
    check(
      'la vista previa dice empresa, rol, quién invita y que no hay cuenta',
      preview.status === 200 &&
        preview.body.tenantName === `Equipo ${run}` &&
        preview.body.roleName === 'Administrador' &&
        preview.body.inviterName === 'Dueño owner' &&
        !preview.body.accountExists,
    );

    const weak = await http('POST', '/invitations/accept-new', {
      body: { token: adminInv.token, name: 'Ad', password: 'corta' },
    });
    check('aceptar con una contraseña débil → 400, sin gastar el enlace', weak.status === 400);

    const admin = await acceptNew('admin', adminInv.token);
    check('aceptar creando la cuenta → sesión directa en la empresa', admin.tenantId === tenantId);

    const reused = await http('POST', '/invitations/accept-new', {
      body: { token: adminInv.token, name: 'Otra vez', password: PASSWORD },
    });
    check('el mismo enlace no sirve dos veces → 400', reused.status === 400);

    const managerInv = await invite(admin, 'manager', roleId('MANAGER'), 'Norte');
    const agentInv = await invite(admin, 'agent', roleId('AGENT'), 'Norte');
    const viewerInv = await invite(admin, 'viewer', roleId('VIEWER'));
    check(
      'el administrador invita a responsable, agente e invitado',
      [managerInv, agentInv, viewerInv].every((i) => i.res.status === 201 && i.token),
    );
    const manager = await acceptNew('manager', managerInv.token);
    const agent = await acceptNew('agent', agentInv.token);
    const viewer = await acceptNew('viewer', viewerInv.token);

    const team = await http<{
      members: Array<{ email: string; status: string; teamName: string | null }>;
      seats: { used: number; limit: number };
    }>('GET', '/team/members', as(viewer));
    check(
      'el invitado ve el equipo: 5 activos, plazas 5 de 5 (plan Starter)',
      team.status === 200 &&
        team.body.members.filter((m) => m.status === 'ACTIVE').length === 5 &&
        team.body.seats.used === 5 &&
        team.body.seats.limit === 5,
      `${team.body.seats?.used}/${team.body.seats?.limit}`,
    );
    check(
      'el equipo del responsable queda guardado',
      team.body.members.find((m) => m.email === email('manager'))?.teamName === 'Norte',
    );

    /* ---------------------------------------------------------------------- */
    section('3 · Plazas del plan');
    const full = await invite(owner, 'extra', roleId('AGENT'));
    check(
      'con las 5 plazas ocupadas, invitar → 403 límite de usuarios',
      full.res.status === 403 && full.res.body.type === TEAM_PROBLEMS.SEAT_LIMIT,
      `${full.res.status}`,
    );
    const fullUser = await db.user.findUnique({ where: { email: email('extra') } });
    check('…y no deja una cuenta a medias', fullUser === null);

    // Pro: 20 plazas y roles personalizados. Se limita a 7 para probar la carrera.
    const pro = await db.plan.findUniqueOrThrow({ where: { code: 'pro' } });
    await db.subscription.update({
      where: { tenantId },
      data: { planId: pro.id, limitOverrides: { maxUsers: 7 } },
    });

    // Muchas a la vez para forzar la carrera: sin el bloqueo por empresa, varias
    // leerían el mismo recuento de plazas y entrarían más de las que caben.
    const racers = Array.from({ length: 12 }, (_, i) => `r${i}`);
    const race = await Promise.all(
      racers.map((who) =>
        http('POST', '/team/invitations', {
          ...as(owner),
          body: { email: email(who), roleId: roleId('VIEWER') },
        }),
      ),
    );
    const accepted = race.filter((r) => r.status === 201).length;
    const rejected = race.filter(
      (r) => r.status === 403 && r.body.type === TEAM_PROBLEMS.SEAT_LIMIT,
    ).length;
    check(
      '12 invitaciones simultáneas con 2 plazas libres → exactamente 2 entran, 10 por límite',
      accepted === 2 && rejected === 10,
      `${accepted} aceptadas, ${rejected} rechazadas`,
    );
    const seatsNow = await db.membership.count({
      where: { tenantId, status: { in: ['ACTIVE', 'INVITED'] } },
    });
    check('…y en la base hay 7 plazas ocupadas, ni una más', seatsNow === 7, `${seatsNow}`);

    const pending = race.filter((r) => r.status === 201);
    const cancelled = await http(
      'DELETE',
      `/team/invitations/${pending[0]!.body.membershipId as string}`,
      as(owner),
    );
    check('cancelar una invitación → 204 y libera la plaza', cancelled.status === 204);
    const afterCancel = await http<{ seats: { used: number } }>('GET', '/team/members', as(owner));
    check('…plazas 6 de 7', afterCancel.body.seats.used === 6, `${afterCancel.body.seats.used}`);

    const cancelMember = await http(
      'DELETE',
      `/team/invitations/${manager.membershipId}`,
      as(owner),
    );
    check(
      'la ruta de invitaciones no da de baja a un miembro activo → 404',
      cancelMember.status === 404,
    );

    const resendTarget = pending[1]!.body;
    const firstToken = tokenFrom(await waitForMail(resendTarget.email as string, 'te invita'));
    const resent = await http(
      'POST',
      `/team/invitations/${resendTarget.membershipId as string}/resend`,
      as(owner),
    );
    const secondToken = tokenFrom(await waitForMail(resendTarget.email as string, 'te invita'));
    const oldPreview = await http('POST', '/invitations/preview', { body: { token: firstToken } });
    const newPreview = await http('POST', '/invitations/preview', { body: { token: secondToken } });
    check(
      'reenviar: el enlace anterior deja de valer y el nuevo sí',
      resent.status === 200 &&
        firstToken !== secondToken &&
        oldPreview.status === 400 &&
        newPreview.status === 200,
      `${resent.status} ${oldPreview.status} ${newPreview.status}`,
    );

    /* ---------------------------------------------------------------------- */
    section('4 · Invitación a una cuenta que ya existe');
    let outsider = await registerOwner('outsider', `Otra ${run}`);
    const outsiderTenantId = outsider.tenantId;
    const outsiderInv = await invite(owner, 'outsider', roleId('AGENT'));
    const outsiderPreview = await http<{ accountExists: boolean }>('POST', '/invitations/preview', {
      body: { token: outsiderInv.token },
    });
    check('la vista previa sabe que ya tiene cuenta', outsiderPreview.body.accountExists === true);

    const hijack = await http('POST', '/invitations/accept-new', {
      body: { token: outsiderInv.token, name: 'Intruso', password: 'Otra-Clave-2026!' },
    });
    check(
      'con cuenta existente, «crear cuenta» con el enlace → 409 (no se pisa la contraseña)',
      hijack.status === 409,
    );

    const wrongAccount = await http('POST', '/invitations/accept', {
      ...as(viewer),
      body: { token: outsiderInv.token },
    });
    const stillValid = await http('POST', '/invitations/preview', {
      body: { token: outsiderInv.token },
    });
    check(
      'aceptarla con la sesión de OTRA cuenta → 403, y el enlace sigue valiendo',
      wrongAccount.status === 403 &&
        wrongAccount.body.type === TEAM_PROBLEMS.INVITATION_EMAIL_MISMATCH &&
        stillValid.status === 200,
    );

    const viaLogin = await http('POST', '/auth/login', {
      body: { email: email('outsider'), password: PASSWORD, invitationToken: outsiderInv.token },
    });
    outsider = sessionFrom(viaLogin);
    check(
      'iniciar sesión con el enlace → acepta y entra directamente en la empresa que invita',
      viaLogin.status === 200 && outsider.tenantId === tenantId,
    );

    /* ---------------------------------------------------------------------- */
    section('5 · Lo que cada rol puede y no puede hacer');
    const matrix: Array<[string, Session, string, string, Body | undefined, number]> = [
      [
        'invitado',
        viewer,
        'POST',
        '/team/invitations',
        { email: email('nope1'), roleId: roleId('VIEWER') },
        403,
      ],
      [
        'agente',
        agent,
        'POST',
        '/team/invitations',
        { email: email('nope2'), roleId: roleId('VIEWER') },
        403,
      ],
      ['agente', agent, 'PATCH', `/team/members/${viewer.membershipId}`, { teamName: 'Sur' }, 403],
      [
        'responsable',
        manager,
        'POST',
        `/team/members/${viewer.membershipId}/disable`,
        undefined,
        403,
      ],
      [
        'responsable',
        manager,
        'POST',
        '/team/roles',
        { name: 'X', permissions: { 'contact:read': 'OWN' } },
        403,
      ],
      [
        'administrador',
        admin,
        'POST',
        '/team/transfer-ownership',
        { membershipId: manager.membershipId, password: PASSWORD, code: '123456' },
        403,
      ],
      ['invitado', viewer, 'GET', '/team/roles', undefined, 200],
    ];
    for (const [label, s, method, path, body, expected] of matrix) {
      const res = await http(method, path, { ...as(s), body });
      check(
        `${label}: ${method} ${path.replace(/[0-9a-f-]{36}/, ':id')} → ${expected}`,
        res.status === expected,
        `${res.status}`,
      );
    }

    /* ---------------------------------------------------------------------- */
    section('6 · Propietario protegido y escalada de privilegios');
    const touchOwner = await http('PATCH', `/team/members/${owner.membershipId}`, {
      ...as(admin),
      body: { roleId: roleId('VIEWER') },
    });
    check(
      'el administrador no puede degradar al propietario → 403',
      touchOwner.body.type === TEAM_PROBLEMS.OWNER_PROTECTED,
    );
    const disableOwner = await http(
      'POST',
      `/team/members/${owner.membershipId}/disable`,
      as(admin),
    );
    check('…ni desactivarlo', disableOwner.status === 403);
    const self = await http('PATCH', `/team/members/${admin.membershipId}`, {
      ...as(admin),
      body: { roleId: roleId('VIEWER') },
    });
    check('nadie cambia su propio rol → 403', self.body.type === TEAM_PROBLEMS.SELF_CHANGE);
    const promoteToOwner = await http('PATCH', `/team/members/${agent.membershipId}`, {
      ...as(admin),
      body: { roleId: roleId('OWNER') },
    });
    check(
      'asignar el rol de propietario → 403',
      promoteToOwner.body.type === TEAM_PROBLEMS.OWNER_PROTECTED,
    );

    const billing = await http<{ id: string; permissions: Body }>('POST', '/team/roles', {
      ...as(owner),
      body: {
        name: 'Facturación',
        permissions: { 'billing:manage': 'ALL', 'contact:read': 'OWN', 'member:read': 'OWN' },
      },
    });
    check(
      'con plan Pro, el propietario crea un rol personalizado; el alcance sin sentido se normaliza',
      billing.status === 201 && billing.body.permissions['member:read'] === 'ALL',
      `${billing.status}`,
    );

    const adminBilling = await http('POST', '/team/roles', {
      ...as(admin),
      body: { name: 'Cobros', permissions: { 'billing:manage': 'ALL' } },
    });
    check(
      'el administrador no puede crear un rol con un permiso que no tiene → 403 escalada',
      adminBilling.body.type === TEAM_PROBLEMS.ESCALATION,
    );

    const assignBilling = await http('PATCH', `/team/members/${agent.membershipId}`, {
      ...as(admin),
      body: { roleId: billing.body.id },
    });
    check(
      '…ni asignarlo a nadie → 403 escalada',
      assignBilling.body.type === TEAM_PROBLEMS.ESCALATION,
    );

    const ownerAssigns = await http('PATCH', `/team/members/${outsider.membershipId}`, {
      ...as(owner),
      body: { roleId: billing.body.id },
    });
    check('el propietario sí lo asigna', ownerAssigns.status === 200);
    const adminTouchesBilling = await http(
      'POST',
      `/team/members/${outsider.membershipId}/disable`,
      as(admin),
    );
    check(
      'el administrador no puede desactivar a quien tiene más permisos que él → 403 escalada',
      adminTouchesBilling.body.type === TEAM_PROBLEMS.ESCALATION,
    );

    const scopeUp = await http('POST', '/team/roles', {
      ...as(manager),
      body: { name: 'Nope', permissions: { 'contact:read': 'ALL' } },
    });
    check(
      'sin role:manage no se crean roles, aunque sea con alcance menor',
      scopeUp.status === 403,
    );

    const junior = await http<{ id: string }>('POST', '/team/roles', {
      ...as(admin),
      body: { name: 'Ventas junior', permissions: { 'contact:read': 'OWN', 'deal:read': 'OWN' } },
    });
    const dupName = await http('POST', '/team/roles', {
      ...as(admin),
      body: { name: 'Ventas junior', permissions: { 'contact:read': 'OWN' } },
    });
    check(
      'el administrador crea un rol dentro de sus permisos; un nombre repetido → 409',
      junior.status === 201 && dupName.status === 409,
    );

    const editSystem = await http('PATCH', `/team/roles/${roleId('AGENT')}`, {
      ...as(owner),
      body: { name: 'Agente', permissions: { 'contact:read': 'ALL' } },
    });
    check('los roles del sistema no se editan → 409', editSystem.status === 409);
    const editBillingAsAdmin = await http('PATCH', `/team/roles/${billing.body.id}`, {
      ...as(admin),
      body: { name: 'Facturación', permissions: { 'contact:read': 'OWN' } },
    });
    check(
      'el administrador no edita un rol que le supera → 403',
      editBillingAsAdmin.body.type === TEAM_PROBLEMS.ESCALATION,
    );
    const deleteInUse = await http('DELETE', `/team/roles/${billing.body.id}`, as(owner));
    check('un rol en uso no se elimina → 409', deleteInUse.status === 409);

    /* ---------------------------------------------------------------------- */
    section('7 · Los cambios se aplican en la siguiente petición');
    const disabled = await http('POST', `/team/members/${agent.membershipId}/disable`, as(admin));
    const agentAfter = await http('GET', '/access', as(agent));
    check(
      'desactivar a un agente: su token (aún vigente) deja de servir al instante → 401',
      disabled.status === 200 &&
        agentAfter.status === 401 &&
        agentAfter.body.type === TEAM_PROBLEMS.MEMBERSHIP_INACTIVE,
      `${agentAfter.status}`,
    );
    const agentRefresh = await http('POST', '/auth/refresh', {
      cookie: agent.cookie,
      client: true,
    });
    check(
      '…y no puede renovar la sesión en esa empresa (no tiene otra) → 403',
      agentRefresh.status === 403,
    );
    const enabled = await http('POST', `/team/members/${agent.membershipId}/enable`, as(admin));
    check(
      'reactivarlo le devuelve el acceso',
      enabled.status === 200 && (await http('GET', '/access', as(agent))).status === 200,
    );

    const managerBefore = await http<{ role: { key: string } }>('GET', '/access', as(manager));
    await http('PATCH', `/team/members/${manager.membershipId}`, {
      ...as(owner),
      body: { roleId: roleId('VIEWER') },
    });
    const managerNow = await http<{ role: { key: string } }>('GET', '/access', as(manager));
    check(
      'cambiar el rol se refleja al instante, con el mismo token (caché invalidada)',
      managerBefore.body.role?.key === 'MANAGER' && managerNow.body.role?.key === 'VIEWER',
      `${managerBefore.body.role?.key} → ${managerNow.body.role?.key}`,
    );

    const removed = await http('DELETE', `/team/members/${outsider.membershipId}`, as(owner));
    const outsiderBlocked = await http('GET', '/access', as(outsider));
    const outsiderRefresh = await http<{ activeTenant: { tenantId: string } }>(
      'POST',
      '/auth/refresh',
      {
        cookie: outsider.cookie,
        client: true,
      },
    );
    check(
      'dar de baja a quien tiene otra empresa: pierde esta al instante…',
      removed.status === 204 && outsiderBlocked.status === 401,
    );
    check(
      '…y al renovar, la sesión sigue en SU empresa en vez de cerrarse',
      outsiderRefresh.status === 200 &&
        outsiderRefresh.body.activeTenant.tenantId === outsiderTenantId,
    );

    /* ---------------------------------------------------------------------- */
    section('8 · Aislamiento entre empresas');
    const foreign = await db.membership.findFirstOrThrow({ where: { tenantId: outsiderTenantId } });
    const acmeRole = await db.role.findFirst({
      where: { tenant: { slug: 'acme' }, key: 'VIEWER' },
    });
    const crossPatch = await http('PATCH', `/team/members/${foreign.id}`, {
      ...as(owner),
      body: { teamName: 'Robado' },
    });
    const crossRole = acmeRole
      ? await http('PATCH', `/team/members/${viewer.membershipId}`, {
          ...as(owner),
          body: { roleId: acmeRole.id },
        })
      : null;
    check(
      'modificar un miembro de otra empresa → 404, como si no existiera',
      crossPatch.status === 404,
    );
    check(
      'asignar un rol de otra empresa → 404',
      crossRole === null || crossRole.status === 404,
      `${crossRole?.status}`,
    );
    const foreignUntouched = await db.membership.findUniqueOrThrow({ where: { id: foreign.id } });
    check('…y el miembro ajeno sigue intacto', foreignUntouched.teamName === null);

    /* ---------------------------------------------------------------------- */
    section('9 · Transferir la propiedad');
    const noTwoFactor = await http('POST', '/team/transfer-ownership', {
      ...as(owner),
      body: { membershipId: admin.membershipId, password: PASSWORD, code: '123456' },
    });
    check('sin 2FA propio, no se puede transferir → 409', noTwoFactor.status === 409);

    const ownerTfa = await enableTwoFactor(owner);
    owner = ownerTfa.session;
    const targetNoTfa = await http('POST', '/team/transfer-ownership', {
      ...as(owner),
      body: { membershipId: admin.membershipId, password: PASSWORD, code: '000000' },
    });
    check(
      'código incorrecto → rechazado',
      targetNoTfa.status === 401 || targetNoTfa.status === 400,
      `${targetNoTfa.status}`,
    );

    await nextStep(ownerTfa.step);
    const noTargetTfa = await http('POST', '/team/transfer-ownership', {
      ...as(owner),
      body: {
        membershipId: admin.membershipId,
        password: PASSWORD,
        code: totpFor(ownerTfa.secret),
      },
    });
    check(
      'el nuevo propietario necesita 2FA → 409',
      noTargetTfa.status === 409,
      `${noTargetTfa.status}`,
    );

    const adminTfa = await enableTwoFactor(admin);
    await nextStep(currentStep());
    const transferred = await http('POST', '/team/transfer-ownership', {
      ...as(owner),
      body: {
        membershipId: adminTfa.session.membershipId,
        password: PASSWORD,
        code: totpFor(ownerTfa.secret),
      },
    });
    check(
      'contraseña + código correctos → 204',
      transferred.status === 204,
      `${transferred.status}`,
    );

    const oldOwner = await http<{ role: { key: string } }>('GET', '/access', as(owner));
    const newOwner = await http<{ role: { key: string } }>('GET', '/access', as(adminTfa.session));
    check(
      'el antiguo propietario pasa a administrador y el elegido a propietario, al instante',
      oldOwner.body.role.key === 'ADMIN' && newOwner.body.role.key === 'OWNER',
    );
    const again = await http('POST', '/team/transfer-ownership', {
      ...as(owner),
      body: { membershipId: adminTfa.session.membershipId, password: PASSWORD, code: '123456' },
    });
    check('el antiguo propietario ya no puede transferir → 403', again.status === 403);
    const owners = await db.membership.count({ where: { tenantId, role: { key: 'OWNER' } } });
    check('queda exactamente un propietario', owners === 1, `${owners}`);

    /* ---------------------------------------------------------------------- */
    section('10 · Auditoría');
    const wanted = ['INVITE', 'ROLE_CHANGE', 'DELETE', 'CREATE'];
    let actions: string[] = [];
    for (let i = 0; i < 30 && !wanted.every((a) => actions.includes(a)); i++) {
      actions = (
        await db.auditLog.findMany({
          where: { tenantId, resourceType: { in: ['Membership', 'Invitation', 'Role'] } },
          select: { action: true },
        })
      ).map((a) => a.action);
      await new Promise((r) => setTimeout(r, 300));
    }
    for (const action of wanted) check(`queda registrado ${action}`, actions.includes(action));
  } finally {
    const users = await db.user.findMany({
      where: { email: { startsWith: `rbac-${run}-` } },
      select: { id: true },
    });
    await db.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await db.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
    await db.$disconnect();
  }

  summarize('Equipo y permisos verificados de extremo a extremo.');
}

main()
  .catch((error: unknown) => {
    console.error('\nLa prueba no pudo completarse:\n', error);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
