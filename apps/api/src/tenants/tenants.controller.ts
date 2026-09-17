import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { requireTenantId, runInTenantTransaction } from '@nexo/database';

@ApiTags('Empresa')
@ApiBearerAuth()
@Controller('tenant')
export class TenantsController {
  /**
   * Datos de la empresa activa.
   *
   * `tenant` no lleva tenant_id (es la empresa), así que la extensión de Prisma
   * no abre la transacción con contexto por sí sola: se abre explícitamente,
   * para que la política RLS de lectura deje ver la fila.
   */
  @Get()
  @ApiOperation({ summary: 'Empresa activa de la sesión' })
  current() {
    const tenantId = requireTenantId();
    return runInTenantTransaction((tx) =>
      tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: {
          id: true,
          slug: true,
          name: true,
          status: true,
          timezone: true,
          currency: true,
          locale: true,
        },
      }),
    );
  }
}
