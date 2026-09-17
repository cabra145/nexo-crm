/**
 * Autoprueba de la criptografía propia de la API contra vectores oficiales.
 *
 *   pnpm --filter @nexo/api crypto:selftest
 *
 * TOTP y base32 están implementados a mano (src/auth/totp.ts). Una
 * implementación propia sólo es aceptable si reproduce EXACTAMENTE los
 * vectores de prueba de su RFC. Corre en CI: un cambio que rompa la
 * compatibilidad con los autenticadores falla aquí, no en el teléfono de un
 * cliente.
 */
import { decrypt, encrypt } from '../src/common/crypto/encryption';
import { hashPassword, needsRehash, verifyPassword } from '../src/auth/password';
import { base32Decode, base32Encode, hotp, verifyTotp } from '../src/auth/totp';

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  console.log('\nRFC 4648 · base32');
  // Vectores de RFC 4648 §10 (sin relleno)
  for (const [raw, encoded] of [
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ] as const) {
    const enc = base32Encode(Buffer.from(raw));
    check(`"${raw}" → "${encoded}"`, enc === encoded && base32Decode(enc).toString() === raw, enc);
  }

  console.log('\nRFC 4226 · HOTP (Apéndice D)');
  const hotpSecret = Buffer.from('12345678901234567890');
  const hotpExpected = [
    '755224',
    '287082',
    '359152',
    '969429',
    '338314',
    '254676',
    '287922',
    '162583',
    '399871',
    '520489',
  ];
  hotpExpected.forEach((expected, counter) => {
    const got = hotp(hotpSecret, counter);
    check(`contador ${counter} → ${expected}`, got === expected, got);
  });

  console.log('\nRFC 6238 · TOTP con SHA-1 (Apéndice B, 8 dígitos)');
  for (const [seconds, expected] of [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ] as const) {
    const got = hotp(hotpSecret, Math.floor(seconds / 30), 8);
    check(`T=${seconds} → ${expected}`, got === expected, got);
  }

  console.log('\nTOTP · ventana de ±30 s');
  const secret = base32Encode(hotpSecret);
  const now = 1_234_567_890_000;
  const codeNow = hotp(hotpSecret, Math.floor(now / 30_000));
  check('acepta el código actual', verifyTotp(secret, codeNow, now) !== null);
  check('acepta el del intervalo anterior', verifyTotp(secret, codeNow, now + 30_000) !== null);
  check('rechaza uno de hace 2 intervalos', verifyTotp(secret, codeNow, now + 60_000) === null);
  check('rechaza un formato inválido', verifyTotp(secret, '12a456', now) === null);

  console.log('\nArgon2id · formato PHC');
  const phc = await hashPassword('Contraseña-de-prueba-1');
  check(
    'formato $argon2id$v=19$m=19456,t=2,p=1$…',
    /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/.test(phc),
  );
  check('verifica la contraseña correcta', await verifyPassword('Contraseña-de-prueba-1', phc));
  check('rechaza una incorrecta', !(await verifyPassword('contraseña-de-prueba-1', phc)));
  check(
    'dos hashes de la misma contraseña difieren (sal aleatoria)',
    phc !== (await hashPassword('Contraseña-de-prueba-1')),
  );
  check('no pide rehash con los parámetros actuales', !needsRehash(phc));
  check(
    'pide rehash si los parámetros son más débiles',
    needsRehash(phc.replace('m=19456', 'm=4096')),
  );

  console.log('\nAES-256-GCM');
  const k = '00'.repeat(32);
  const sealed = encrypt('secreto TOTP', k);
  check('cifra y descifra', decrypt(sealed, k) === 'secreto TOTP');
  check(
    'dos cifrados del mismo texto difieren (IV aleatorio)',
    sealed !== encrypt('secreto TOTP', k),
  );
  const parts = sealed.split('.');
  const tampered = [
    parts[0],
    parts[1],
    parts[2],
    Buffer.from('x' + Buffer.from(parts[3]!, 'base64url').toString('latin1')).toString('base64url'),
  ].join('.');
  let rejected = false;
  try {
    decrypt(tampered, k);
  } catch {
    rejected = true;
  }
  check('rechaza un valor alterado', rejected);

  console.log(
    failed
      ? `\n${failed} comprobación(es) FALLIDA(S)`
      : '\nCriptografía verificada contra los vectores oficiales.',
  );
  process.exitCode = failed ? 1 : 0;
}

void main();
