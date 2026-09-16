import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import type { z, ZodTypeAny } from 'zod';

export interface FieldError {
  field: string;
  message: string;
}

/**
 * Error de validación con el detalle por campo.
 *
 * El filtro de errores lo convierte en un problema RFC 7807 con `errors[]`,
 * que la web pinta junto a cada input.
 */
export class ValidationException extends BadRequestException {
  constructor(readonly errors: FieldError[]) {
    super('Los datos enviados no son válidos');
  }
}

/**
 * Valida con los esquemas zod de `@nexo/contracts`.
 *
 * Son LOS MISMOS esquemas que usa el formulario en el navegador, así que una
 * regla de validación no puede divergir entre cliente y servidor.
 *
 * @example
 * @Post()
 * create(@Body(new ZodValidationPipe(createContactSchema)) body: CreateContact) {}
 */
@Injectable()
export class ZodValidationPipe<T extends ZodTypeAny> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      throw new ValidationException(
        result.error.issues.map((issue) => ({
          field: issue.path.join('.') || '(cuerpo)',
          message: issue.message,
        })),
      );
    }

    return result.data;
  }
}
