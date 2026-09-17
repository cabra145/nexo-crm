import { Injectable } from '@nestjs/common';
import type { EmailTokenPurpose } from '@nexo/database';
import { generateToken, sha256 } from '../common/crypto/tokens';
import { DatabaseService } from '../database/database.service';

/**
 * Enlaces de un solo uso: verificación de correo, recuperación de contraseña e
 * invitaciones.
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

  /* --- Invitaciones -------------------------------------------------------- */

  /**
   * Enlace de invitación a una empresa. Lleva en `payload` la empresa y la
   * membresía invitada.
   *
   * A diferencia de `create`, sólo invalida los enlaces anteriores de ESTA
   * membresía: invitar a la misma persona a dos empresas no debe anular la
   * primera invitación.
   */
  async createInvitation(
    userId: string,
    payload: InvitationPayload,
    ttlMs: number,
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = generateToken();
    const expiresAt = new Date(Date.now() + ttlMs);
    await this.revokeInvitations(payload.membershipId);
    await this.db.platform.emailToken.create({
      data: {
        userId,
        purpose: 'INVITATION',
        tokenHash: sha256(token),
        payload: { ...payload },
        expiresAt,
      },
    });
    return { token, expiresAt };
  }

  /** Invalida los enlaces pendientes de una invitación (reenvío, cancelación, baja). */
  async revokeInvitations(membershipId: string): Promise<void> {
    await this.db.platform.$executeRaw`
      UPDATE email_token
         SET used_at = now()
       WHERE purpose = 'INVITATION'::"EmailTokenPurpose"
         AND used_at IS NULL
         AND payload->>'membershipId' = ${membershipId}
    `;
  }

  /** Lee una invitación válida SIN canjearla (para mostrarla antes de aceptar). */
  async peekInvitation(token: string): Promise<ValidInvitation | null> {
    const row = await this.db.platform.emailToken.findUnique({
      where: { tokenHash: sha256(token) },
    });
    if (!row || row.purpose !== 'INVITATION' || row.usedAt || row.expiresAt <= new Date()) {
      return null;
    }
    const payload = parseInvitationPayload(row.payload);
    return payload ? { userId: row.userId, expiresAt: row.expiresAt, ...payload } : null;
  }

  /** Canjea una invitación de forma atómica. Null si no es válida o ya se usó. */
  async consumeInvitation(token: string): Promise<ValidInvitation | null> {
    const rows = await this.db.platform.$queryRaw<
      Array<{ user_id: string; expires_at: Date; payload: unknown }>
    >`
      UPDATE email_token
         SET used_at = now()
       WHERE token_hash = ${sha256(token)}
         AND purpose = 'INVITATION'::"EmailTokenPurpose"
         AND used_at IS NULL
         AND expires_at > now()
      RETURNING user_id::text, expires_at, payload
    `;
    const row = rows[0];
    const payload = row ? parseInvitationPayload(row.payload) : null;
    return row && payload ? { userId: row.user_id, expiresAt: row.expires_at, ...payload } : null;
  }

  /** Vencimiento del enlace pendiente de cada membresía invitada. */
  async pendingInvitationExpiry(membershipIds: string[]): Promise<Map<string, Date>> {
    if (membershipIds.length === 0) return new Map();
    const rows = await this.db.platform.$queryRaw<
      Array<{ membership_id: string; expires_at: Date }>
    >`
      SELECT payload->>'membershipId' AS membership_id, max(expires_at) AS expires_at
        FROM email_token
       WHERE purpose = 'INVITATION'::"EmailTokenPurpose"
         AND used_at IS NULL
         AND payload->>'membershipId' = ANY(${membershipIds}::text[])
       GROUP BY 1
    `;
    return new Map(rows.map((r) => [r.membership_id, r.expires_at]));
  }
}

export interface InvitationPayload {
  tenantId: string;
  membershipId: string;
}

export interface ValidInvitation extends InvitationPayload {
  userId: string;
  expiresAt: Date;
}

function parseInvitationPayload(value: unknown): InvitationPayload | null {
  if (value === null || typeof value !== 'object') return null;
  const { tenantId, membershipId } = value as Record<string, unknown>;
  return typeof tenantId === 'string' && typeof membershipId === 'string'
    ? { tenantId, membershipId }
    : null;
}
