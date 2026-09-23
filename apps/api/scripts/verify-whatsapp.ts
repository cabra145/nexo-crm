/**
 * Verifica un canal de WhatsApp contra Meta REAL: token, número, cuenta de
 * WhatsApp Business, suscripción de la app y webhook.
 *
 *   pnpm --filter @nexo/api verify:whatsapp                  (el único conectado)
 *   pnpm --filter @nexo/api verify:whatsapp -- --numero 123  (por phone_number_id)
 *   pnpm --filter @nexo/api verify:whatsapp -- --enviar 5939…  (envío REAL)
 *
 * Sólo lee, salvo `--enviar`, que manda un mensaje de verdad al número que se
 * indique: cuesta dinero y abre una conversación. El token nunca se imprime.
 */
import { decrypt, PrismaClient } from '@nexo/database';
import { sendTestMessage, verifyWhatsappChannel, type VerifyTarget } from './lib/verify-whatsapp';

interface Args {
  phoneNumberId?: string;
  channelId?: string;
  sendTo?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1];
    if (argv[i] === '--numero' && value) args.phoneNumberId = value;
    if (argv[i] === '--canal' && value) args.channelId = value;
    if (argv[i] === '--enviar' && value) args.sendTo = value;
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) {
    console.error('\n✗ Falta ENCRYPTION_KEY: sin ella no se pueden leer las credenciales.\n');
    process.exit(1);
  }

  // Cliente directo: esto es una herramienta de operación, no una petición de
  // usuario, y tiene que ver los canales de la empresa que se le indique.
  const db = new PrismaClient({ datasourceUrl: process.env.DIRECT_DATABASE_URL });
  try {
    const channels = await db.channel.findMany({
      where: {
        type: 'WHATSAPP_CLOUD',
        status: { not: 'DISABLED' },
        ...(args.channelId ? { id: args.channelId } : {}),
        ...(args.phoneNumberId ? { externalId: args.phoneNumberId } : {}),
      },
      select: {
        id: true,
        name: true,
        externalId: true,
        displayId: true,
        config: true,
        credentialsEncrypted: true,
        webhookSecretEncrypted: true,
        tenant: { select: { name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    if (channels.length === 0) {
      console.error('\n✗ No hay ningún canal de WhatsApp conectado que verificar.\n');
      process.exit(1);
    }
    if (channels.length > 1) {
      console.error(
        '\nHay varios canales conectados. Elige uno con --canal <id> o --numero <id>:\n',
      );
      for (const channel of channels) {
        console.error(
          `  ${channel.id}  ${channel.displayId ?? '—'}  ${channel.name}  (${channel.tenant.name})`,
        );
      }
      console.error('');
      process.exit(1);
    }

    const channel = channels[0]!;
    if (!channel.credentialsEncrypted || !channel.webhookSecretEncrypted || !channel.externalId) {
      console.error(
        '\n✗ El canal está a medio conectar: vuelve a conectarlo en Ajustes → Canales.\n',
      );
      process.exit(1);
    }
    const { accessToken } = JSON.parse(decrypt(channel.credentialsEncrypted, encryptionKey)) as {
      accessToken: string;
    };
    const apiPublicUrl =
      process.env.API_PUBLIC_URL ?? `http://localhost:${process.env.API_PORT ?? 4000}`;
    const target: VerifyTarget = {
      graphUrl: process.env.META_GRAPH_URL ?? 'https://graph.facebook.com',
      version: process.env.META_GRAPH_VERSION ?? 'v21.0',
      accessToken,
      phoneNumberId: channel.externalId,
      wabaId: (channel.config as { wabaId?: string } | null)?.wabaId ?? null,
      displayId: channel.displayId,
      webhookUrl: `${apiPublicUrl.replace(/\/$/, '')}/api/v1/webhooks/whatsapp/${channel.id}`,
      verifyToken: decrypt(channel.webhookSecretEncrypted, encryptionKey),
    };

    console.log('\nVerificación del canal de WhatsApp');
    console.log(`  empresa:  ${channel.tenant.name}`);
    console.log(`  canal:    ${channel.name} · ${channel.displayId ?? '—'}`);
    console.log(`  Graph:    ${new URL(target.graphUrl).host} ${target.version}`);
    console.log(`  webhook:  ${target.webhookUrl}\n`);

    const checks = await verifyWhatsappChannel(target);
    if (args.sendTo) {
      console.log(`  (enviando un mensaje de prueba a ${args.sendTo}…)`);
      checks.push(
        await sendTestMessage(
          target,
          args.sendTo,
          'Prueba de Nexo CRM: si recibes esto, el canal está bien configurado.',
        ),
      );
    }

    for (const check of checks) {
      console.log(
        `  ${check.ok ? '✓' : '✗'} ${check.name}${check.detail ? `  — ${check.detail}` : ''}`,
      );
    }
    const failed = checks.filter((c) => !c.ok).length;
    console.log(`\n${checks.length - failed}/${checks.length} comprobaciones superadas`);
    if (failed > 0) {
      console.error('\nCanal NO listo. Revisa docs/validacion-2.4.md.\n');
      process.exitCode = 1;
    } else {
      console.log('Canal verificado contra Meta.\n');
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${(error as Error).message}\n`);
  process.exit(1);
});
