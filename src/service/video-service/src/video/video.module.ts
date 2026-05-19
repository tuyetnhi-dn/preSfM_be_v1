import { Module } from '@nestjs/common';
import { DatabaseModule } from '../common/database/database.module';
import { VideoController } from './video.controller';
import { VideoService } from './video.service';

@Module({
  imports: [DatabaseModule],
  controllers: [VideoController],
  providers: [VideoService],
})
export class VideoModule {}
