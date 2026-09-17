import { BRAND, copyrightLine } from '@nexo/contracts';

/**
 * Plantillas de los correos de autenticación.
 *
 * Cada una tiene versión de texto y HTML: hay clientes y filtros que sólo
 * muestran texto, y un correo sólo en HTML puntúa peor como spam.
 *
 * El HTML usa tablas y estilos en línea a propósito: es lo único que los
 * clientes de correo (Outlook incluido) interpretan de forma consistente.
 * La versión final con la identidad visual completa llega en el bloque 1.2b.
 */
export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function layout(params: {
  preheader: string;
  heading: string;
  body: string;
  cta?: { label: string; url: string };
  footnote: string;
}): string {
  const button = params.cta
    ? `<tr><td style="padding:8px 0 24px">
         <a href="${escape(params.cta.url)}" style="display:inline-block;background:#0c6b60;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:6px">${escape(params.cta.label)}</a>
       </td></tr>
       <tr><td style="font-size:12px;color:#5d6a66;padding-bottom:24px">Si el botón no funciona, copia este enlace en tu navegador:<br><span style="word-break:break-all;color:#28322f">${escape(params.cta.url)}</span></td></tr>`
    : '';
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(params.heading)}</title></head>
<body style="margin:0;background:#edf1ef;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#28322f">
<span style="display:none;max-height:0;overflow:hidden">${escape(params.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px"><tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #cbd5d1;border-radius:8px;padding:32px">
    <tr><td style="font-weight:700;font-size:14px;color:#121917;padding-bottom:24px">${escape(BRAND.fullName)}</td></tr>
    <tr><td style="font-size:20px;font-weight:600;color:#121917;padding-bottom:12px">${escape(params.heading)}</td></tr>
    <tr><td style="font-size:15px;line-height:1.55;padding-bottom:20px">${params.body}</td></tr>
    ${button}
    <tr><td style="font-size:12px;line-height:1.5;color:#5d6a66;border-top:1px solid #dde4e1;padding-top:16px">${params.footnote}</td></tr>
  </table>
  <p style="font-size:11px;color:#87938f;margin:16px 0 0">${escape(copyrightLine())}</p>
</td></tr></table>
</body></html>`;
}

export function verificationEmail(p: { name: string; url: string; hours: number }): RenderedMail {
  return {
    subject: `Confirma tu correo para entrar en ${BRAND.fullName}`,
    text: `Hola, ${p.name}:\n\nConfirma tu correo para activar tu cuenta:\n${p.url}\n\nEl enlace caduca en ${p.hours} horas. Si no creaste esta cuenta, ignora este mensaje.`,
    html: layout({
      preheader: 'Un clic para activar tu cuenta.',
      heading: 'Confirma tu correo',
      body: `Hola, ${escape(p.name)}. Falta un paso para activar tu cuenta: confirmar que este correo es tuyo.`,
      cta: { label: 'Confirmar mi correo', url: p.url },
      footnote: `El enlace caduca en ${p.hours} horas. Si no creaste esta cuenta, ignora este mensaje: nadie podrá usarla sin confirmar el correo.`,
    }),
  };
}

export function accountAlreadyExistsEmail(p: {
  name: string;
  loginUrl: string;
  resetUrl: string;
}): RenderedMail {
  return {
    subject: `Ya tienes una cuenta en ${BRAND.fullName}`,
    text: `Hola, ${p.name}:\n\nAlguien intentó registrarse con este correo, pero ya tienes una cuenta.\n\nEntrar: ${p.loginUrl}\n¿Olvidaste tu contraseña? ${p.resetUrl}\n\nSi no fuiste tú, puedes ignorar este mensaje: no se ha cambiado nada.`,
    html: layout({
      preheader: 'Alguien intentó registrarse con tu correo.',
      heading: 'Ya tienes una cuenta',
      body: `Hola, ${escape(p.name)}. Alguien intentó registrarse con este correo, pero ya existe una cuenta asociada a él. Si fuiste tú, entra con tu contraseña, o <a href="${escape(p.resetUrl)}" style="color:#0c6b60">recupérala</a> si no la recuerdas.`,
      cta: { label: 'Entrar', url: p.loginUrl },
      footnote: 'Si no fuiste tú, ignora este mensaje: no se ha cambiado nada en tu cuenta.',
    }),
  };
}

export function passwordResetEmail(p: {
  name: string;
  url: string;
  minutes: number;
}): RenderedMail {
  return {
    subject: `Restablece tu contraseña de ${BRAND.fullName}`,
    text: `Hola, ${p.name}:\n\nPara elegir una contraseña nueva, abre este enlace:\n${p.url}\n\nCaduca en ${p.minutes} minutos y sólo sirve una vez. Si no lo pediste, ignora este mensaje: tu contraseña no cambia.`,
    html: layout({
      preheader: 'Enlace para elegir una contraseña nueva.',
      heading: 'Restablece tu contraseña',
      body: `Hola, ${escape(p.name)}. Pediste restablecer tu contraseña. Con este enlace eliges una nueva.`,
      cta: { label: 'Elegir contraseña nueva', url: p.url },
      footnote: `Caduca en ${p.minutes} minutos y sólo sirve una vez. Si no lo pediste, ignora este mensaje: tu contraseña no cambia.`,
    }),
  };
}

export function passwordChangedEmail(p: { name: string; resetUrl: string }): RenderedMail {
  return {
    subject: `Tu contraseña de ${BRAND.fullName} ha cambiado`,
    text: `Hola, ${p.name}:\n\nLa contraseña de tu cuenta acaba de cambiar y se cerraron todas las sesiones abiertas.\n\nSi no fuiste tú, recupera el acceso ahora: ${p.resetUrl}`,
    html: layout({
      preheader: 'Se cerraron todas tus sesiones.',
      heading: 'Tu contraseña ha cambiado',
      body: `Hola, ${escape(p.name)}. La contraseña de tu cuenta acaba de cambiar, y por seguridad se cerraron todas las sesiones abiertas.`,
      footnote: `Si no fuiste tú, <a href="${escape(p.resetUrl)}" style="color:#0c6b60">recupera el acceso ahora</a> y avisa al administrador de tu empresa.`,
    }),
  };
}

export function twoFactorChangedEmail(p: { name: string; enabled: boolean }): RenderedMail {
  const what = p.enabled ? 'activado' : 'desactivado';
  return {
    subject: `Verificación en dos pasos ${what} en ${BRAND.fullName}`,
    text: `Hola, ${p.name}:\n\nSe ha ${what} la verificación en dos pasos de tu cuenta.${p.enabled ? ' Por seguridad, se cerraron las demás sesiones.' : ''}\n\nSi no fuiste tú, cambia tu contraseña de inmediato y avisa al administrador de tu empresa.`,
    html: layout({
      preheader: `Verificación en dos pasos ${what}.`,
      heading: `Verificación en dos pasos ${what}`,
      body: `Hola, ${escape(p.name)}. Se ha ${what} la verificación en dos pasos de tu cuenta.${p.enabled ? ' Por seguridad, se cerraron las demás sesiones abiertas.' : ''}`,
      footnote:
        'Si no fuiste tú, cambia tu contraseña de inmediato y avisa al administrador de tu empresa.',
    }),
  };
}

export function invitationEmail(p: {
  inviterName: string | null;
  tenantName: string;
  roleName: string;
  url: string;
  days: number;
  accountExists: boolean;
}): RenderedMail {
  const who = p.inviterName ? `${p.inviterName} te invita` : 'Te invitan';
  const how = p.accountExists
    ? 'Entra con tu cuenta de siempre para aceptar.'
    : 'Solo tienes que elegir una contraseña.';
  return {
    subject: `${who} a ${p.tenantName} en ${BRAND.fullName}`,
    text: `Hola:\n\n${who} a unirte a ${p.tenantName} en ${BRAND.fullName} como ${p.roleName}. ${how}\n\nAcepta la invitación aquí:\n${p.url}\n\nEl enlace caduca en ${p.days} días. Si no esperabas esta invitación, ignora este mensaje.`,
    html: layout({
      preheader: `${who} a ${p.tenantName}.`,
      heading: `Únete a ${p.tenantName}`,
      body: `${escape(who)} a unirte a <strong>${escape(p.tenantName)}</strong> en ${escape(BRAND.fullName)} como <strong>${escape(p.roleName)}</strong>. ${escape(how)}`,
      cta: { label: 'Aceptar la invitación', url: p.url },
      footnote: `El enlace caduca en ${p.days} días. Si no esperabas esta invitación, ignora este mensaje: no se creará nada.`,
    }),
  };
}
