import { Injectable } from '@nestjs/common';
import type { EmailTokenPurpose } from '@nexo/database';
import { generateToken, sha256 } from '../common/crypto/tokens';
import { DatabaseService } from '../database/database.service';

/**
 * Enlaces de un solo uso: verificación de correo y recuperación de contraseña.
 *
 * El token en claro sólo existe en el enlace del correo; la base guarda su
 * SHA-256. Canjear es UNA sentencia UPDATE … WHERE used_at IS NULL, así que dos
 * clics simultáneos en el mismo enlace no pueden canjearlo los dos.
 */
@Injectable()
export class EmailTokensService {
  constructor(private readonly db: DatabaseService) {}

  async create(userId: string, purpose: EmailTokenPurpose, ttlMs: number): Promise<string> {
    const token = generateToken();
    // Un enlace nuevo invalida los anteriores del mismo tipo: sólo vale el
    // último correo recibido.
    await this.db.platform.emailToken.updateMany({
      where: { userId, purpose, usedAt: null },
      data: { usedAt: new Date() },
    });
    await this.db.platform.emailToken.create({
      data: { userId, purpose, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttlMs) },
    });
    return token;
  }

  /** Canjea el token. Devuelve el id del usuario, o null si no es válido. */
  async consume(token: string, purpose: EmailTokenPurpose): Promise<string | null> {
    const rows = await this.db.platform.$queryRaw<Array<{ user_id: string }>>`
      UPDATE email_token
         SET used_at = now()
       WHERE token_hash = ${sha256(token)}
         AND purpose = ${purpose}::"EmailTokenPurpose"
         AND used_at IS NULL
         AND expires_at > now()
      RETURNING user_id::text
    `;
    return rows[0]?.user_id ?? null;
  }
}
