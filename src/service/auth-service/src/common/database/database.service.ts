import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { Pool } from 'pg';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private pool: Pool | undefined;

  onModuleInit() {
    this.pool = new Pool({
      host: process.env.POSTGRES_HOST,
      port: Number(process.env.POSTGRES_PORT ?? 5432),
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DB,
      ssl:
        process.env.POSTGRES_SSL === 'true'
          ? { rejectUnauthorized: false }
          : false,
      max: 10, // tối đa 10 connections trong pool
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    this.pool.on('error', (err) => {
      this.logger.error('Unexpected DB pool error', err);
    });

    this.logger.log(`DB pool created → ${process.env.POSTGRES_HOST}`);
  }

  async onModuleDestroy() {
    if (this.pool) {
      await this.pool.end();
      this.logger.log('DB pool closed');
    }
  }

  async query(text: string, params?: unknown[]) {
    const start = Date.now();
    try {
      if (!this.pool) {
        throw new Error('Database pool is not initialized');
      }
      const result = await this.pool.query(text, params);
      const duration = Date.now() - start;
      this.logger.debug(`query [${duration}ms] ${text.slice(0, 80)}`);
      return result;
    } catch (error) {
      this.logger.error(`query failed: ${text.slice(0, 80)}`, error);
      throw error;
    }
  }
}
