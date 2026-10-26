import { Module } from '@nestjs/common';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { AppointmentWriter } from './appointment-writer.service';
import { AppointmentsController } from './appointments.controller';
import { AppointmentsService } from './appointments.service';
import { AvailabilityService } from './availability.service';
import { OffersService } from './offers.service';
import { SchedulingCron } from './scheduling.cron';

@Module({
  imports: [WhatsappModule],
  controllers: [AppointmentsController],
  providers: [AvailabilityService, AppointmentWriter, OffersService, AppointmentsService, SchedulingCron],
  exports: [AvailabilityService, AppointmentsService, OffersService],
})
export class SchedulingModule {}
