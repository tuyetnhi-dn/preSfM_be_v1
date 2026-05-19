import { Module } from '@nestjs/common';
import { DatabaseModule } from '../common/database/database.module';
import { EvaluationController } from './evaluation.controller';
import { EvaluationService } from './evaluation.service';

@Module({
  imports: [DatabaseModule],
  controllers: [EvaluationController],
  providers: [EvaluationService],
})
export class EvaluationModule {}
