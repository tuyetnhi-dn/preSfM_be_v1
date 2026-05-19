import { Module } from '@nestjs/common';
import { DatabaseModule } from '../common/database/database.module';
import { OpenSfmController } from './opensfm.controller';
import { OpenSfmService } from './opensfm.service';

@Module({
  imports: [DatabaseModule],
  controllers: [OpenSfmController],
  providers: [OpenSfmService],
})
export class OpenSfmModule {}
