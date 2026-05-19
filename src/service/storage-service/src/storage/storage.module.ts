import { Module } from '@nestjs/common';
import { DatabaseModule } from '../common/database/database.module';
import { StorageController } from './storage.controller';
import { StorageService } from './storage.service';

@Module({
  imports: [DatabaseModule],
  controllers: [StorageController],
  providers: [StorageService],
})
export class StorageModule {}
