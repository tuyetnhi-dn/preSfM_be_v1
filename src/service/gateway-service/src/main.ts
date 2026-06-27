/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  const expressApp = app.getHttpAdapter().getInstance();

  if (typeof expressApp.disable === 'function') {
    expressApp.disable('etag');
  }
  const port = Number(process.env.PORT || 8000);
  await app.listen(port, '0.0.0.0');
}

bootstrap();
