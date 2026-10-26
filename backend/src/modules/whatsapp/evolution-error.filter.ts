import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { Response } from 'express';
import { EvolutionApiError } from './evolution.client';

/**
 * Converte falhas do Evolution Go em respostas amigáveis (503), sem expor detalhes
 * do provedor à barbearia — para ela, o serviço é apenas "WhatsApp".
 */
@Catch(EvolutionApiError)
export class EvolutionErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(EvolutionErrorFilter.name);

  catch(err: EvolutionApiError, host: ArgumentsHost): void {
    this.logger.error(err.message);
    const licenseRequired = /LICENSE_REQUIRED|not activated/i.test(JSON.stringify(err.body ?? '')) || /license/i.test(err.message);
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(HttpStatus.SERVICE_UNAVAILABLE)
      .json({
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        error: 'Service Unavailable',
        code: licenseRequired ? 'WHATSAPP_NOT_ACTIVATED' : 'WHATSAPP_UNAVAILABLE',
        message: licenseRequired
          ? 'O serviço de WhatsApp da plataforma ainda não foi ativado. Avise o suporte e tente novamente mais tarde.'
          : 'O serviço de WhatsApp está temporariamente indisponível. Tente novamente em alguns minutos.',
      });
  }
}
