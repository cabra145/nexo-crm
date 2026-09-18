import { Module } from '@nestjs/common';
import { TeamModule } from '../team/team.module';
import { CompaniesService } from './companies.service';
import { ContactsService } from './contacts.service';
import { AgendaController } from './agenda.controller';
import { CrmController } from './crm.controller';
import { NotesService } from './notes.service';
import { TasksService } from './tasks.service';
import { TagsService } from './tags.service';

@Module({
  imports: [TeamModule],
  controllers: [CrmController, AgendaController],
  providers: [ContactsService, CompaniesService, TagsService, TasksService, NotesService],
})
export class CrmModule {}
