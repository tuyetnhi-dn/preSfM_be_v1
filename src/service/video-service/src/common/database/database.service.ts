import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, QueryResult, QueryResultRow } from 'pg';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private pool!: Pool;
  pipelineRun: any;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    this.pool = new Pool({
      host: this.configService.get<string>('POSTGRES_HOST', 'postgres'),
      port: Number(this.configService.get<string>('POSTGRES_PORT', '5432')),
      user: this.configService.get<string>('POSTGRES_USER', 'postgres'),
      password: this.configService.get<string>('POSTGRES_PASSWORD', 'postgres'),
      database: this.configService.get<string>('POSTGRES_DB', 'postgres'),
      max: Number(this.configService.get<string>('POSTGRES_POOL_MAX', '10')),
      ssl:
        this.configService.get<string>('POSTGRES_SSL', 'false') === 'true'
          ? { rejectUnauthorized: false }
          : undefined,
    });
  }

  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, params);
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
