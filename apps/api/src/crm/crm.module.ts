import { Module } from '@nestjs/common';
import { TeamModule } from '../team/team.module';
import { CompaniesService } from './companies.service';
import { ContactsService } from './contacts.service';
import { CrmController } from './crm.controller';
import { TagsService } from './tags.service';

@Module({
  imports: [TeamModule],
  controllers: [CrmController],
  providers: [ContactsService, CompaniesService, TagsService],
})
export class CrmModule {}
