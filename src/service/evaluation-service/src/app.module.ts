import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EvaluationModule } from './evaluation/evaluation.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), EvaluationModule],
})
export class AppModule {}
