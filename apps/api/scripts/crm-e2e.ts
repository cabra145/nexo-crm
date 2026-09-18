/**
 * Prueba de extremo a extremo del CRM, contra la API REAL.
 *
 * Lo que de verdad importa aquí es el ALCANCE: que un agente sólo vea lo suyo,
 * un responsable lo de su equipo y un administrador todo, en el listado, en la
 * búsqueda, en la ficha y al editar. Además: duplicados de correo y teléfono,
 * cuota de contactos del plan (incluida la carrera), etiquetas, empresas,
 * paginación por cursor, aislamiento entre empresas y rastro (auditoría y
 * actividad).
 *
 * Necesita API, worker y Mailpit en marcha, y el rol dueño de la base para
 * ajustar el plan y limpiar. Crea sus propias empresas y las borra al terminar.
 *
 *   pnpm --filter @nexo/api crm:e2e
 */
import { CRM_PROBLEMS } from '@nexo/contracts';
import { PrismaClient } from '@nexo/database';
import {
  check,
  http,
  type HttpResult,
  section,
  summarize,
  tokenFrom,
  waitForMail,
} from './lib/e2e';

const run = Date.now().toString(36);
const PASSWORD = 'Contactos-Seguros-2026';
const email = (who: string) => `crm-${run}-${who}@nexo.test`;

interface Session {
  accessToken: string;
  userId: string;
  membershipId: string;
  tenantId: string;
}

const as = (s: Session) => ({ token: s.accessToken });

const sessionFrom = (res: HttpResult): Session => {
  const body = res.body as {
    accessToken: string;
    user: { id: string };
    activeTenant: { membershipId: string; tenantId: string };
  };
  return {
    accessToken: body.accessToken,
    userId: body.user.id,
    membershipId: body.activeTenant.membershipId,
    tenantId: body.activeTenant.tenantId,
  };
};

interface ContactBody {
  id: string;
  fullName: string;
  email: string | null;
  companyName: string | null;
  company: { id: string; name: string } | null;
  owner: { id: string; name: string } | null;
  lifecycleStage: string;
  tags: Array<{ id: string; name: string }>;
}
interface ListBody {
  data: ContactBody[];
  nextCursor: string | null;
  hasMore: boolean;
}

async function main(): Promise<void> {
  const db = new PrismaClient({ datasourceUrl: process.env.DIRECT_DATABASE_URL });
  console.log(`\nCRM de extremo a extremo · ejecución ${run}`);
  const tenantIds: string[] = [];

  async function registerOwner(who: string, company: string): Promise<Session> {
    const t = Date.now();
    await http('POST', '/auth/register', {
      body: { name: `Dueña ${who}`, email: email(who), password: PASSWORD, companyName: company },
    });
    await http('POST', '/auth/verify-email', {
      body: { token: tokenFrom(await waitForMail(email(who), 'Confirma tu correo', t)) },
    });
    const login = await http('POST', '/auth/login', {
      body: { email: email(who), password: PASSWORD },
    });
    const session = sessionFrom(login);
    tenantIds.push(session.tenantId);
    return session;
  }

  /** Invita con un rol y acepta con cuenta nueva, sin pasar por el login. */
  async function addMember(
    by: Session,
    who: string,
    roleId: string,
    teamName?: string,
  ): Promise<Session> {
    const t = Date.now();
    const invited = await http('POST', '/team/invitations', {
      ...as(by),
      body: { email: email(who), roleId, teamName },
    });
    if (invited.status !== 201) {
      throw new Error(`invitación de ${who} → ${invited.status} ${JSON.stringify(invited.body)}`);
    }
    const token = tokenFrom(await waitForMail(email(who), 'te invita', t));
    const accepted = await http('POST', '/invitations/accept-new', {
      body: { token, name: `Equipo ${who}`, password: PASSWORD },
    });
    if (accepted.status !== 200) {
      throw new Error(`aceptar ${who} → ${accepted.status} ${JSON.stringify(accepted.body)}`);
    }
    return sessionFrom(accepted);
  }

  const newContact = (s: Session, body: Record<string, unknown>) =>
    http<ContactBody>('POST', '/contacts', { ...as(s), body });

  const listContacts = (s: Session, query = '') =>
    http<ListBody>('GET', `/contacts${query}`, as(s));

  try {
    /* ---------------------------------------------------------------------- */
    section('1 · Equipo de la prueba');
    const owner = await registerOwner('owner', `CRM ${run}`);
    const tenantId = owner.tenantId;

    // Plan Pro con plazas y contactos de sobra; la cuota se prueba al final.
    const pro = await db.plan.findUniqueOrThrow({ where: { code: 'pro' } });
    await db.subscription.update({
      where: { tenantId },
      data: { planId: pro.id, limitOverrides: { maxUsers: 10, maxContacts: 100 } },
    });

    const roles = await http<{ roles: Array<{ id: string; key: string }> }>(
      'GET',
      '/team/roles',
      as(owner),
    );
    const roleId = (key: string) => roles.body.roles.find((r) => r.key === key)!.id;

    const admin = await addMember(owner, 'admin', roleId('ADMIN'));
    const manager = await addMember(owner, 'manager', roleId('MANAGER'), 'Norte');
    const agentNorte = await addMember(owner, 'agente-norte', roleId('AGENT'), 'Norte');
    const agentSur = await addMember(owner, 'agente-sur', roleId('AGENT'), 'Sur');
    const viewer = await addMember(owner, 'invitado', roleId('VIEWER'));
    check('equipo listo: administrador, responsable, dos agentes e invitado', true);

    /* ---------------------------------------------------------------------- */
    section('2 · Alta, validación y duplicados');
    const created = await newContact(owner, {
      firstName: 'Juan',
      lastName: 'Pérez',
      email: `juan-${run}@cliente.test`,
      phoneE164: '+593987650001',
      jobTitle: 'Gerente de compras',
      companyName: 'Ferretería El Tornillo',
    });
    check(
      'crear un contacto → 201, con el nombre completo compuesto por la base',
      created.status === 201 && created.body.fullName === 'Juan Pérez',
      `${created.status} ${created.body.fullName}`,
    );
    check(
      '…y el responsable es quien lo creó',
      created.body.owner?.id === owner.userId,
      created.body.owner?.name,
    );

    const badPhone = await newContact(owner, { firstName: 'Mal', phoneE164: '0987654321' });
    check(
      'un teléfono que no está en E.164 → 400 con el error en su campo',
      badPhone.status === 400 &&
        (badPhone.body as unknown as { errors?: Array<{ field: string }> }).errors?.some(
          (e) => e.field === 'phoneE164',
        ) === true,
      `${badPhone.status}`,
    );

    const noName = await newContact(owner, { firstName: '' });
    check('sin nombre → 400', noName.status === 400);

    const dupEmail = await newContact(owner, {
      firstName: 'Otro',
      email: `juan-${run}@cliente.test`,
    });
    check(
      'el mismo correo en otro contacto → 409, diciendo cuál lo tiene',
      dupEmail.status === 409 &&
        (dupEmail.body as unknown as { type: string; resourceId?: string }).type ===
          CRM_PROBLEMS.DUPLICATE_CONTACT &&
        (dupEmail.body as unknown as { resourceId?: string }).resourceId === created.body.id,
      `${dupEmail.status}`,
    );

    const dupPhone = await newContact(owner, { firstName: 'Otro', phoneE164: '+593987650001' });
    check('el mismo teléfono → 409', dupPhone.status === 409, `${dupPhone.status}`);

    const upperEmail = await newContact(owner, {
      firstName: 'Mayúsculas',
      email: `JUAN-${run}@cliente.test`,
    });
    check(
      'el correo no distingue mayúsculas: sigue siendo duplicado',
      upperEmail.status === 409,
      `${upperEmail.status}`,
    );

    /* ---------------------------------------------------------------------- */
    section('3 · Alcance por rol: listado y ficha');
    const delNorte = await newContact(agentNorte, {
      firstName: 'Cliente',
      lastName: 'del Norte',
      email: `norte-${run}@cliente.test`,
    });
    const delSur = await newContact(agentSur, {
      firstName: 'Cliente',
      lastName: 'del Sur',
      email: `sur-${run}@cliente.test`,
    });
    const sinDuenno = await newContact(owner, {
      firstName: 'Sin',
      lastName: 'Responsable',
      ownerId: null,
      email: `libre-${run}@cliente.test`,
    });
    // ownerId: null explícito debe dejarlo sin responsable, no asignárselo a quien lo crea.
    check(
      'se puede crear un contacto sin responsable',
      sinDuenno.status === 201 && sinDuenno.body.owner === null,
      JSON.stringify(sinDuenno.body.owner),
    );

    const porAgente = await listContacts(agentNorte);
    const idsAgente = porAgente.body.data.map((c) => c.id);
    check(
      'el agente sólo ve SUS contactos',
      porAgente.status === 200 &&
        idsAgente.includes(delNorte.body.id) &&
        !idsAgente.includes(delSur.body.id) &&
        !idsAgente.includes(created.body.id) &&
        !idsAgente.includes(sinDuenno.body.id),
      `${idsAgente.length} contacto(s)`,
    );

    const fichaAjena = await http('GET', `/contacts/${delSur.body.id}`, as(agentNorte));
    const editaAjena = await http('PATCH', `/contacts/${delSur.body.id}`, {
      ...as(agentNorte),
      body: { jobTitle: 'Robado' },
    });
    const borraAjena = await http('DELETE', `/contacts/${delSur.body.id}`, as(agentNorte));
    check(
      'la ficha de un contacto ajeno → 404, como si no existiera',
      fichaAjena.status === 404 && editaAjena.status === 404 && borraAjena.status === 403,
      `ficha ${fichaAjena.status}, editar ${editaAjena.status}, borrar ${borraAjena.status}`,
    );

    const porResponsable = await listContacts(manager);
    const idsResponsable = porResponsable.body.data.map((c) => c.id);
    check(
      'el responsable ve los de SU equipo (Norte), no los de otro (Sur)',
      idsResponsable.includes(delNorte.body.id) && !idsResponsable.includes(delSur.body.id),
      `${idsResponsable.length} contacto(s)`,
    );

    const porAdmin = await listContacts(admin);
    const idsAdmin = porAdmin.body.data.map((c) => c.id);
    check(
      'el administrador ve todos, incluido el que no tiene responsable',
      [created.body.id, delNorte.body.id, delSur.body.id, sinDuenno.body.id].every((id) =>
        idsAdmin.includes(id),
      ),
      `${idsAdmin.length} contacto(s)`,
    );

    const porInvitado = await listContacts(viewer);
    const creaInvitado = await newContact(viewer, { firstName: 'No', lastName: 'Debería' });
    check(
      'el invitado lee pero no escribe',
      porInvitado.status === 200 && creaInvitado.status === 403,
      `leer ${porInvitado.status}, crear ${creaInvitado.status}`,
    );

    const mioDelAdmin = await newContact(admin, {
      firstName: 'Propio',
      lastName: 'Del administrador',
      email: `admin-${run}@cliente.test`,
    });
    const filtroMios = await listContacts(admin, '?mine=true');
    const idsMios = filtroMios.body.data.map((c) => c.id);
    check(
      '«sólo los míos» deja fuera los de los demás, aunque el rol los vea todos',
      idsMios.includes(mioDelAdmin.body.id) &&
        !idsMios.includes(delNorte.body.id) &&
        !idsMios.includes(created.body.id),
      `${idsMios.length} contacto(s)`,
    );
    const filtroSinDuenno = await listContacts(admin, '?unassigned=true');
    check(
      '«sin responsable» encuentra exactamente los que no lo tienen',
      filtroSinDuenno.body.data.length === 1 &&
        filtroSinDuenno.body.data[0]!.id === sinDuenno.body.id,
      `${filtroSinDuenno.body.data.length}`,
    );

    /* ---------------------------------------------------------------------- */
    section('4 · Búsqueda');
    const espera = async (query: string, id: string, label: string) => {
      const res = await listContacts(admin, `?q=${encodeURIComponent(query)}`);
      check(
        label,
        res.body.data.some((c) => c.id === id),
        `«${query}» → ${res.body.data.length}`,
      );
    };
    await espera('perez', created.body.id, 'busca sin acentos y encuentra «Pérez»');
    await espera('Juan Pérez', created.body.id, 'busca por nombre completo');
    await espera('erez', created.body.id, 'busca por un trozo del apellido (trigram)');
    await espera('650001', created.body.id, 'busca por los últimos dígitos del teléfono');
    await espera('tornillo', created.body.id, 'busca por el nombre de la empresa del contacto');

    const buscaAgente = await listContacts(agentNorte, '?q=Cliente');
    check(
      'la búsqueda respeta el alcance: el agente no encuentra los ajenos',
      buscaAgente.body.data.length === 1 && buscaAgente.body.data[0]!.id === delNorte.body.id,
      `${buscaAgente.body.data.length} resultado(s)`,
    );

    /* ---------------------------------------------------------------------- */
    section('5 · Etiquetas');
    const tag = await http<{ id: string; name: string; color: string }>('POST', '/tags', {
      ...as(admin),
      body: { name: 'Mayorista' },
    });
    const dupTag = await http('POST', '/tags', { ...as(admin), body: { name: 'Mayorista' } });
    check(
      'crear una etiqueta → 201, con color de la paleta; repetir el nombre → 409',
      tag.status === 201 && /^#[0-9A-F]{6}$/i.test(tag.body.color) && dupTag.status === 409,
      `${tag.status} ${tag.body.color} / ${dupTag.status}`,
    );

    const etiquetado = await http<ContactBody>('PATCH', `/contacts/${created.body.id}`, {
      ...as(admin),
      body: { tagIds: [tag.body.id] },
    });
    check(
      'asignar la etiqueta a un contacto',
      etiquetado.body.tags.some((t) => t.id === tag.body.id),
    );
    const porEtiqueta = await listContacts(admin, `?tagId=${tag.body.id}`);
    check(
      'filtrar por etiqueta',
      porEtiqueta.body.data.length === 1 && porEtiqueta.body.data[0]!.id === created.body.id,
      `${porEtiqueta.body.data.length}`,
    );

    const borraEtiquetaAgente = await http('DELETE', `/tags/${tag.body.id}`, as(agentNorte));
    check(
      'un agente no puede eliminar una etiqueta de toda la empresa → 403',
      borraEtiquetaAgente.status === 403,
    );
    const borraEtiqueta = await http('DELETE', `/tags/${tag.body.id}`, as(admin));
    const trasBorrar = await http<ContactBody>('GET', `/contacts/${created.body.id}`, as(admin));
    check(
      'el administrador la elimina y desaparece de los contactos',
      borraEtiqueta.status === 204 && trasBorrar.body.tags.length === 0,
      `${borraEtiqueta.status}`,
    );

    /* ---------------------------------------------------------------------- */
    section('6 · Empresas');
    const company = await http<{ id: string; name: string; contactCount: number }>(
      'POST',
      '/companies',
      { ...as(admin), body: { name: `Distribuidora ${run}`, industry: 'Comercio', city: 'Quito' } },
    );
    const webMala = await http('POST', '/companies', {
      ...as(admin),
      body: { name: 'Sitio raro', website: 'no es una web' },
    });
    check(
      'crear una empresa → 201; una dirección web inválida → 400',
      company.status === 201 && webMala.status === 400,
      `${company.status} / ${webMala.status}`,
    );

    await http('PATCH', `/contacts/${created.body.id}`, {
      ...as(admin),
      body: { companyId: company.body.id },
    });
    const conContacto = await http<{ contactCount: number }>(
      'GET',
      `/companies/${company.body.id}`,
      as(admin),
    );
    check(
      'la ficha de la empresa cuenta sus contactos',
      conContacto.body.contactCount === 1,
      `${conContacto.body.contactCount}`,
    );

    const empresaInexistente = await http('PATCH', `/contacts/${created.body.id}`, {
      ...as(admin),
      body: { companyId: '00000000-0000-7000-8000-000000000000' },
    });
    check(
      'vincular a una empresa que no existe → 400 en su campo',
      empresaInexistente.status === 400,
      `${empresaInexistente.status}`,
    );

    const borraEmpresa = await http('DELETE', `/companies/${company.body.id}`, as(admin));
    const contactoTrasBorrar = await http<ContactBody>(
      'GET',
      `/contacts/${created.body.id}`,
      as(admin),
    );
    check(
      'al eliminar la empresa, sus contactos NO se borran: se desvinculan conservando el nombre',
      borraEmpresa.status === 204 &&
        contactoTrasBorrar.status === 200 &&
        contactoTrasBorrar.body.company === null &&
        contactoTrasBorrar.body.companyName === `Distribuidora ${run}`,
      `${borraEmpresa.status} · empresa: ${contactoTrasBorrar.body.companyName}`,
    );

    /* ---------------------------------------------------------------------- */
    section('7 · Borrado de contactos');
    const paraBorrar = await newContact(admin, {
      firstName: 'Temporal',
      email: `temporal-${run}@cliente.test`,
    });
    const borrado = await http('DELETE', `/contacts/${paraBorrar.body.id}`, as(admin));
    const trasBorrado = await http('GET', `/contacts/${paraBorrar.body.id}`, as(admin));
    check(
      'eliminar un contacto lo saca de la vista',
      borrado.status === 204 && trasBorrado.status === 404,
      `${borrado.status} / ${trasBorrado.status}`,
    );
    const reusaCorreo = await newContact(admin, {
      firstName: 'Nuevo',
      email: `temporal-${run}@cliente.test`,
    });
    check(
      '…y libera su correo para volver a usarlo',
      reusaCorreo.status === 201,
      `${reusaCorreo.status}`,
    );

    /* ---------------------------------------------------------------------- */
    section('8 · Paginación por cursor');
    for (let i = 0; i < 4; i++) {
      await newContact(admin, { firstName: `Página ${i}`, lastName: `Prueba ${run}` });
    }
    const page1 = await listContacts(admin, '?limit=2');
    const page2 = await listContacts(admin, `?limit=2&cursor=${page1.body.nextCursor}`);
    const ids1 = page1.body.data.map((c) => c.id);
    const ids2 = page2.body.data.map((c) => c.id);
    check(
      'dos páginas de 2 sin repetir ni saltarse nada',
      page1.body.data.length === 2 &&
        page2.body.data.length === 2 &&
        page1.body.hasMore &&
        ids1.every((id) => !ids2.includes(id)),
      `${ids1.length} + ${ids2.length}`,
    );

    /* ---------------------------------------------------------------------- */
    section('9 · Aislamiento entre empresas');
    const otra = await registerOwner('otra', `Otra CRM ${run}`);
    const suyo = await newContact(otra, {
      firstName: 'Ajeno',
      lastName: 'Total',
      email: `ajeno-${run}@cliente.test`,
    });
    const verAjeno = await http('GET', `/contacts/${suyo.body.id}`, as(admin));
    const editarAjeno = await http('PATCH', `/contacts/${suyo.body.id}`, {
      ...as(admin),
      body: { jobTitle: 'Robado' },
    });
    const buscarAjeno = await listContacts(admin, '?q=Ajeno');
    check(
      'un contacto de otra empresa no se ve, no se edita y no aparece en la búsqueda',
      verAjeno.status === 404 && editarAjeno.status === 404 && buscarAjeno.body.data.length === 0,
      `${verAjeno.status} / ${editarAjeno.status} / ${buscarAjeno.body.data.length}`,
    );
    const intacto = await db.contact.findUniqueOrThrow({ where: { id: suyo.body.id } });
    check('…y sigue intacto', intacto.jobTitle === null);

    /* ---------------------------------------------------------------------- */
    section('10 · Cuota de contactos del plan');
    const usados = await db.contact.count({ where: { tenantId, deletedAt: null } });
    await db.subscription.update({
      where: { tenantId },
      data: { limitOverrides: { maxUsers: 10, maxContacts: usados + 2 } },
    });
    const uso = await http<{ contacts: { used: number; limit: number } }>(
      'GET',
      '/contacts/uso',
      as(admin),
    );
    check(
      'el uso informa de contactos usados y límite',
      uso.body.contacts.used === usados && uso.body.contacts.limit === usados + 2,
      `${uso.body.contacts.used}/${uso.body.contacts.limit}`,
    );

    // Con 2 plazas libres y 8 altas a la vez, el bloqueo por empresa decide.
    const carrera = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        newContact(admin, { firstName: `Carrera ${i}`, lastName: `${run}` }),
      ),
    );
    const aceptadas = carrera.filter((r) => r.status === 201).length;
    const porCuota = carrera.filter(
      (r) =>
        r.status === 403 &&
        (r.body as unknown as { type: string }).type === CRM_PROBLEMS.CONTACT_QUOTA,
    ).length;
    const finales = await db.contact.count({ where: { tenantId, deletedAt: null } });
    check(
      '8 altas simultáneas con 2 huecos → exactamente 2 entran',
      aceptadas === 2 && porCuota === 6,
      `${aceptadas} altas, ${porCuota} por cuota`,
    );
    check(
      '…y la base queda justo en el límite, ni uno más',
      finales === usados + 2,
      `${finales} de ${usados + 2}`,
    );

    /* ---------------------------------------------------------------------- */
    section('11 · Tareas');
    const hoy = new Date();
    const ayer = new Date(Date.now() - 86_400_000);
    const manana = new Date(Date.now() + 86_400_000);

    const tarea = await http<{ id: string; assignee: { id: string } | null; status: string }>(
      'POST',
      '/tasks',
      {
        ...as(agentNorte),
        body: {
          title: 'Llamar para confirmar el pedido',
          dueAt: hoy.toISOString(),
          contactId: delNorte.body.id,
        },
      },
    );
    check(
      'crear una tarea → 201, asignada a quien la crea',
      tarea.status === 201 && tarea.body.assignee?.id === agentNorte.userId,
      `${tarea.status}`,
    );

    const tareaAjena = await http('POST', '/tasks', {
      ...as(agentNorte),
      body: { title: 'Sobre un contacto que no veo', contactId: delSur.body.id },
    });
    check(
      'vincular una tarea a un contacto fuera de tu alcance → 400',
      tareaAjena.status === 400,
      `${tareaAjena.status}`,
    );

    const aExterno = await http('POST', '/tasks', {
      ...as(admin),
      body: { title: 'Para alguien de fuera', assigneeId: otra.userId },
    });
    check(
      'asignar una tarea a quien no es del equipo → 400',
      aExterno.status === 400,
      `${aExterno.status}`,
    );

    // Tramos: una atrasada, una de hoy, una futura y una sin fecha.
    await http('POST', '/tasks', {
      ...as(agentNorte),
      body: { title: 'Atrasada', dueAt: ayer.toISOString() },
    });
    await http('POST', '/tasks', {
      ...as(agentNorte),
      body: { title: 'Próxima', dueAt: manana.toISOString() },
    });
    await http('POST', '/tasks', { ...as(agentNorte), body: { title: 'Algún día' } });

    interface TaskListBody {
      data: Array<{ id: string; title: string; status: string; completedAt: string | null }>;
    }
    const tramo = (s: Session, bucket: string) =>
      http<TaskListBody>('GET', `/tasks?bucket=${bucket}&tzOffset=0`, as(s));

    const atrasadas = await tramo(agentNorte, 'overdue');
    const deHoy = await tramo(agentNorte, 'today');
    const proximas = await tramo(agentNorte, 'upcoming');
    const sinFecha = await tramo(agentNorte, 'someday');
    check(
      'los tramos reparten bien: atrasada, hoy, próxima y sin fecha',
      atrasadas.body.data.every((t) => t.title === 'Atrasada') &&
        atrasadas.body.data.length === 1 &&
        deHoy.body.data.length === 1 &&
        proximas.body.data.length === 1 &&
        sinFecha.body.data.length === 1,
      `${atrasadas.body.data.length}/${deHoy.body.data.length}/${proximas.body.data.length}/${sinFecha.body.data.length}`,
    );

    const delOtroAgente = await tramo(agentSur, 'today');
    check(
      'un agente no ve las tareas de otro',
      delOtroAgente.body.data.length === 0,
      `${delOtroAgente.body.data.length}`,
    );
    const paraElResponsable = await tramo(manager, 'today');
    check(
      'el responsable ve las de su equipo',
      paraElResponsable.body.data.some((t) => t.id === tarea.body.id),
    );

    const completada = await http<{ status: string; completedAt: string | null }>(
      'PATCH',
      `/tasks/${tarea.body.id}`,
      { ...as(agentNorte), body: { status: 'DONE' } },
    );
    check(
      'completar una tarea guarda cuándo se hizo',
      completada.status === 200 &&
        completada.body.status === 'DONE' &&
        completada.body.completedAt !== null,
      `${completada.body.completedAt}`,
    );
    const hechas = await tramo(agentNorte, 'done');
    const hoyTrasCompletar = await tramo(agentNorte, 'today');
    check(
      '…y pasa del tramo de hoy al de hechas',
      hechas.body.data.some((t) => t.id === tarea.body.id) &&
        !hoyTrasCompletar.body.data.some((t) => t.id === tarea.body.id),
    );

    const reabierta = await http<{ status: string; completedAt: string | null }>(
      'PATCH',
      `/tasks/${tarea.body.id}`,
      { ...as(agentNorte), body: { status: 'PENDING' } },
    );
    check(
      'reabrirla borra la fecha de cierre',
      reabierta.body.status === 'PENDING' && reabierta.body.completedAt === null,
    );

    const editaAjenaTarea = await http('PATCH', `/tasks/${tarea.body.id}`, {
      ...as(agentSur),
      body: { title: 'Robada' },
    });
    check('editar la tarea de otro agente → 404', editaAjenaTarea.status === 404);

    const borraTarea = await http('DELETE', `/tasks/${tarea.body.id}`, as(agentNorte));
    const trasBorrarTarea = await tramo(agentNorte, 'someday');
    check(
      'eliminar una tarea la saca de los listados',
      borraTarea.status === 204 && !trasBorrarTarea.body.data.some((t) => t.id === tarea.body.id),
      `${borraTarea.status}`,
    );

    /* ---------------------------------------------------------------------- */
    section('12 · Notas');
    interface NoteBody {
      id: string;
      body: string;
      author: { id: string; name: string } | null;
      canEdit: boolean;
    }
    const nota = await http<NoteBody>('POST', `/contacts/${delNorte.body.id}/notes`, {
      ...as(agentNorte),
      body: { body: 'Pidió cotización de 200 unidades. Llamar el lunes.' },
    });
    check(
      'añadir una nota → 201, con su autor',
      nota.status === 201 && nota.body.author?.id === agentNorte.userId && nota.body.canEdit,
      `${nota.status}`,
    );

    const notaVacia = await http('POST', `/contacts/${delNorte.body.id}/notes`, {
      ...as(agentNorte),
      body: { body: '   ' },
    });
    check('una nota vacía → 400', notaVacia.status === 400, `${notaVacia.status}`);

    const notaEnAjeno = await http('POST', `/contacts/${delSur.body.id}/notes`, {
      ...as(agentNorte),
      body: { body: 'No debería poder' },
    });
    check('escribir en un contacto fuera de tu alcance → 404', notaEnAjeno.status === 404);

    const notasDelResponsable = await http<NoteBody[]>(
      'GET',
      `/contacts/${delNorte.body.id}/notes`,
      as(manager),
    );
    check(
      'el responsable lee las notas de su equipo, pero no puede editarlas',
      notasDelResponsable.status === 200 &&
        notasDelResponsable.body.length === 1 &&
        notasDelResponsable.body[0]!.canEdit === false,
      `${notasDelResponsable.body.length} nota(s)`,
    );
    const editaNotaAjena = await http('PATCH', `/notes/${nota.body.id}`, {
      ...as(manager),
      body: { body: 'Reescrita por otro' },
    });
    check('…y si lo intenta → 403', editaNotaAjena.status === 403, `${editaNotaAjena.status}`);

    const editaPropia = await http<NoteBody>('PATCH', `/notes/${nota.body.id}`, {
      ...as(agentNorte),
      body: { body: 'Pidió cotización de 300 unidades.' },
    });
    check(
      'el autor sí la edita',
      editaPropia.status === 200 && editaPropia.body.body.includes('300'),
    );

    const adminEdita = await http('PATCH', `/notes/${nota.body.id}`, {
      ...as(admin),
      body: { body: 'Corregida por administración.' },
    });
    check(
      'quien gestiona los datos (contact:delete) también puede corregirla',
      adminEdita.status === 200,
      `${adminEdita.status}`,
    );

    /* ---------------------------------------------------------------------- */
    section('13 · Historia del contacto');
    const historia = await http<Array<{ type: string; title: string }>>(
      'GET',
      `/contacts/${delNorte.body.id}/historia`,
      as(agentNorte),
    );
    check(
      'la historia cuenta la creación, la tarea y la nota, de lo más reciente',
      historia.status === 200 &&
        historia.body.some((a) => a.type === 'SYSTEM' && a.title === 'Contacto creado') &&
        historia.body.some((a) => a.type === 'TASK' && a.title.startsWith('Tarea creada')) &&
        historia.body.some((a) => a.type === 'TASK' && a.title.startsWith('Tarea completada')) &&
        historia.body.some((a) => a.type === 'NOTE'),
      historia.body.map((a) => a.type).join(', '),
    );
    const historiaAjena = await http('GET', `/contacts/${delSur.body.id}/historia`, as(agentNorte));
    check('la historia de un contacto ajeno → 404', historiaAjena.status === 404);

    const borraNota = await http('DELETE', `/notes/${nota.body.id}`, as(agentNorte));
    const notasTrasBorrar = await http<NoteBody[]>(
      'GET',
      `/contacts/${delNorte.body.id}/notes`,
      as(agentNorte),
    );
    check(
      'eliminar la nota la quita de la lista',
      borraNota.status === 204 && notasTrasBorrar.body.length === 0,
      `${borraNota.status}`,
    );

    /* ---------------------------------------------------------------------- */
    section('14 · Rastro: auditoría y actividad del contacto');
    await http('PATCH', `/contacts/${created.body.id}`, {
      ...as(admin),
      body: { lifecycleStage: 'CUSTOMER' },
    });
    let acciones: string[] = [];
    for (
      let i = 0;
      i < 30 && !['CREATE', 'UPDATE', 'DELETE'].every((a) => acciones.includes(a));
      i++
    ) {
      acciones = (
        await db.auditLog.findMany({
          where: { tenantId, resourceType: { in: ['Contact', 'Company', 'Tag', 'Task', 'Note'] } },
          select: { action: true },
        })
      ).map((a) => a.action);
      await new Promise((r) => setTimeout(r, 300));
    }
    for (const accion of ['CREATE', 'UPDATE', 'DELETE']) {
      check(`queda auditado ${accion}`, acciones.includes(accion));
    }

    const actividad = await db.activity.findMany({
      where: { tenantId, contactId: created.body.id },
      select: { type: true, title: true },
      orderBy: { occurredAt: 'asc' },
    });
    check(
      'la actividad del contacto guarda su creación y el cambio de etapa',
      actividad.some((a) => a.type === 'SYSTEM' && a.title === 'Contacto creado') &&
        actividad.some((a) => a.type === 'STAGE_CHANGE'),
      actividad.map((a) => a.type).join(', '),
    );
  } finally {
    const users = await db.user.findMany({
      where: { email: { startsWith: `crm-${run}-` } },
      select: { id: true },
    });
    await db.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await db.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
    await db.$disconnect();
  }

  summarize('CRM verificado de extremo a extremo.');
}

main()
  .catch((error: unknown) => {
    console.error('\nLa prueba no pudo completarse:\n', error);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
