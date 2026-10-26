import { Module } from '@nestjs/common';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';

@Module({
  imports: [WhatsappModule],
  controllers: [TenantsController],
  providers: [TenantsService],
})
export class TenantsModule {}
