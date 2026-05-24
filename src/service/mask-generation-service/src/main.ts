import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: true,
    credentials: true,
  });

  const port = Number(process.env.PORT ?? 8002);

  await app.listen(port, '0.0.0.0');

  console.log(`mask-generation-service is running on port ${port}`);
}

void bootstrap();
