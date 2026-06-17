import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { VideoModule } from './video/video.module';
import { BullModule } from '@nestjs/bullmq';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST ?? 'redis',
        port: Number(process.env.REDIS_PORT ?? 6379),
      },
    }),
    VideoModule,
  ],
})
export class AppModule {}
