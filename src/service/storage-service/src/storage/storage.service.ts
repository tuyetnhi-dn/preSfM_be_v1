import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { DatabaseService } from '../common/database/database.service';

type UploadInput = {
  file: Express.Multer.File;
  bucket?: string;
  path?: string;
  uploadedBy?: string;
  projectId?: string;
  datasetId?: string;
};

type StoredFile = {
  id: string;
  provider: 'supabase' | 'local';
  bucket: string;
  object_path: string;
  original_name: string | null;
  mime_type: string | null;
  size_bytes: string;
};

@Injectable()
export class StorageService {
  constructor(
    private readonly configService: ConfigService,
    private readonly databaseService: DatabaseService,
  ) {}

  async upload(input: UploadInput) {
    if (!input.file) {
      throw new BadRequestException('File is required');
    }
    const bucket = this.safeSegment(
      input.bucket ||
        this.configService.get<string>('SUPABASE_DEFAULT_BUCKET', 'presfm'),
    );
    const objectPath = this.normalizeObjectPath(
      input.path || `${Date.now()}-${input.file.originalname}`,
    );
    const provider = this.isSupabaseEnabled() ? 'supabase' : 'local';
    const checksum = createHash('sha256')
      .update(input.file.buffer)
      .digest('hex');
    if (provider === 'supabase') {
      await this.uploadToSupabase(
        bucket,
        objectPath,
        input.file.buffer,
        input.file.mimetype || 'application/octet-stream',
      );
    } else {
      await this.uploadToLocal(bucket, objectPath, input.file.buffer);
    }
    const result = await this.databaseService.query<StoredFile>(
      `INSERT INTO storage_files(provider, bucket, object_path, original_name, mime_type, size_bytes, checksum_sha256, uploaded_by, project_id, dataset_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT(provider, bucket, object_path)
       DO UPDATE SET original_name = EXCLUDED.original_name,
                     mime_type = EXCLUDED.mime_type,
                     size_bytes = EXCLUDED.size_bytes,
                     checksum_sha256 = EXCLUDED.checksum_sha256,
                     uploaded_by = EXCLUDED.uploaded_by,
                     project_id = EXCLUDED.project_id,
                     dataset_id = EXCLUDED.dataset_id
       RETURNING id, provider, bucket, object_path, original_name, mime_type, size_bytes`,
      [
        provider,
        bucket,
        objectPath,
        input.file.originalname || null,
        input.file.mimetype || null,
        input.file.size,
        checksum,
        input.uploadedBy || null,
        input.projectId || null,
        input.datasetId || null,
      ],
    );
    return this.toResponse(result.rows[0]);
  }

  async findById(id: string) {
    const result = await this.databaseService.query<StoredFile>(
      `SELECT id, provider, bucket, object_path, original_name, mime_type, size_bytes
       FROM storage_files
       WHERE id = $1`,
      [id],
    );
    const file = result.rows[0];
    if (!file) {
      throw new NotFoundException('Storage file not found');
    }
    return this.toResponse(file);
  }

  async downloadById(id: string) {
    const result = await this.databaseService.query<StoredFile>(
      `SELECT id, provider, bucket, object_path, original_name, mime_type, size_bytes
       FROM storage_files
       WHERE id = $1`,
      [id],
    );
    const file = result.rows[0];
    if (!file) {
      throw new NotFoundException('Storage file not found');
    }
    const buffer =
      file.provider === 'supabase'
        ? await this.downloadFromSupabase(file.bucket, file.object_path)
        : await readFile(this.localPath(file.bucket, file.object_path));
    return {
      buffer,
      filename:
        file.original_name || file.object_path.split('/').pop() || file.id,
      mimeType: file.mime_type || 'application/octet-stream',
      size: Number(file.size_bytes),
    };
  }

  async createSignedUrl(input: {
    bucket: string;
    path: string;
    expiresIn?: number;
  }) {
    const bucket = this.safeSegment(input.bucket);
    const objectPath = this.normalizeObjectPath(input.path);
    const expiresIn = input.expiresIn ?? 3600;

    const fileResult = await this.databaseService.query<StoredFile>(
      `SELECT id, provider, bucket, object_path, original_name, mime_type, size_bytes
     FROM storage_files
     WHERE bucket = $1 AND object_path = $2
     LIMIT 1`,
      [bucket, objectPath],
    );

    const file = fileResult.rows[0];

    if (!file) {
      throw new NotFoundException('Storage file not found');
    }

    if (file.provider === 'local') {
      const url = this.publicDownloadUrl(file.id);

      return {
        bucket,
        path: objectPath,
        signedUrl: url,
        url,
        expiresIn,
        provider: file.provider,
      };
    }

    if (!this.isSupabaseEnabled()) {
      const url = this.publicDownloadUrl(file.id);

      return {
        bucket,
        path: objectPath,
        signedUrl: url,
        url,
        expiresIn,
        provider: file.provider,
      };
    }

    const encodedPath = objectPath
      .split('/')
      .map((item) => encodeURIComponent(item))
      .join('/');

    const response = await fetch(
      `${this.supabaseUrl()}/storage/v1/object/sign/${bucket}/${encodedPath}`,
      {
        method: 'POST',
        headers: this.supabaseJsonHeaders(),
        body: JSON.stringify({
          expiresIn,
        }),
      },
    );

    if (!response.ok) {
      const url = this.publicDownloadUrl(file.id);

      return {
        bucket,
        path: objectPath,
        signedUrl: url,
        url,
        expiresIn,
        provider: file.provider,
        signedUrlError: await response.text(),
      };
    }

    const data = (await response.json()) as Record<string, unknown>;

    const signedUrl =
      data.signedUrl ?? data.signedURL ?? data.url ?? data.path ?? null;

    if (!signedUrl) {
      const url = this.publicDownloadUrl(file.id);

      return {
        bucket,
        path: objectPath,
        signedUrl: url,
        url,
        expiresIn,
        provider: file.provider,
        signedUrlError: 'Supabase did not return signed URL',
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-base-to-string
    const normalizedSignedUrl = this.normalizeSignedUrl(String(signedUrl));

    return {
      bucket,
      path: objectPath,
      signedUrl: normalizedSignedUrl,
      url: normalizedSignedUrl,
      expiresIn,
      provider: file.provider,
    };
  }
  private normalizeSignedUrl(url: string) {
    if (url.startsWith('http') && url.includes('/storage/v1/object/sign/')) {
      return url;
    }

    const supabaseUrl = this.supabaseUrl();

    if (!supabaseUrl) {
      return url;
    }

    if (url.startsWith('/object/sign/')) {
      return `${supabaseUrl}/storage/v1${url}`;
    }

    if (url.startsWith('object/sign/')) {
      return `${supabaseUrl}/storage/v1/${url}`;
    }

    if (
      url.includes('/object/sign/') &&
      !url.includes('/storage/v1/object/sign/')
    ) {
      return url.replace('/object/sign/', '/storage/v1/object/sign/');
    }

    return url;
  }

  private publicDownloadUrl(storageFileId: string) {
    const baseUrl = this.configService
      .get<string>('API_PUBLIC_URL', 'http://localhost:8000/api')
      .replace(/\/+$/, '');

    return `${baseUrl}/storage/files/${encodeURIComponent(storageFileId)}/download`;
  }

  async signedUrl(bucket: string, objectPath: string, expiresIn = 3600) {
    const safeBucket = this.safeSegment(bucket);
    const safePath = this.normalizeObjectPath(objectPath);
    if (!this.isSupabaseEnabled()) {
      return {
        signedUrl: null,
        provider: 'local',
        bucket: safeBucket,
        path: safePath,
      };
    }
    const response = await fetch(
      `${this.supabaseUrl()}/storage/v1/object/sign/${safeBucket}/${safePath}`,
      {
        method: 'POST',
        headers: this.supabaseJsonHeaders(),
        body: JSON.stringify({ expiresIn }),
      },
    );
    if (!response.ok) {
      throw new BadRequestException(await response.text());
    }
    const data = (await response.json()) as {
      signedURL?: string;
      signedUrl?: string;
    };
    const url = data.signedURL || data.signedUrl || null;
    return {
      signedUrl: url ? `${this.supabaseUrl()}${url}` : null,
      provider: 'supabase',
      bucket: safeBucket,
      path: safePath,
    };
  }

  async remove(id: string) {
    const file = await this.findById(id);
    if (file.provider === 'supabase') {
      await fetch(
        `${this.supabaseUrl()}/storage/v1/object/${file.bucket}/${file.objectPath}`,
        {
          method: 'DELETE',
          headers: this.supabaseJsonHeaders(),
        },
      );
    } else {
      await rm(this.localPath(file.bucket, file.objectPath), { force: true });
    }
    await this.databaseService.query(
      `DELETE FROM storage_files WHERE id = $1`,
      [id],
    );
    return { success: true };
  }

  private async uploadToSupabase(
    bucket: string,
    objectPath: string,
    buffer: Buffer,
    contentType: string,
  ) {
    const response = await fetch(
      `${this.supabaseUrl()}/storage/v1/object/${bucket}/${objectPath}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.supabaseKey()}`,
          apikey: this.supabaseKey(),
          'content-type': contentType,
          'x-upsert': 'true',
        },
        body: buffer as unknown as BodyInit,
      },
    );
    if (!response.ok) {
      throw new BadRequestException(await response.text());
    }
  }

  private async downloadFromSupabase(bucket: string, objectPath: string) {
    const response = await fetch(
      `${this.supabaseUrl()}/storage/v1/object/authenticated/${bucket}/${objectPath}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.supabaseKey()}`,
          apikey: this.supabaseKey(),
        },
      },
    );
    if (!response.ok) {
      throw new NotFoundException(await response.text());
    }
    return Buffer.from(await response.arrayBuffer());
  }

  private async uploadToLocal(
    bucket: string,
    objectPath: string,
    buffer: Buffer,
  ) {
    const fullPath = this.localPath(bucket, objectPath);
    await mkdir(fullPath.split('/').slice(0, -1).join('/'), {
      recursive: true,
    });
    await writeFile(fullPath, buffer);
  }

  private localPath(bucket: string, objectPath: string) {
    return join(
      this.configService.get<string>(
        'LOCAL_STORAGE_ROOT',
        '/data/presfm-storage',
      ),
      bucket,
      objectPath,
    );
  }

  private isSupabaseEnabled() {
    return Boolean(
      this.configService.get<string>('SUPABASE_URL') &&
      this.configService.get<string>('SUPABASE_SERVICE_ROLE_KEY'),
    );
  }

  private supabaseUrl() {
    return this.configService
      .get<string>('SUPABASE_URL', '')
      .replace(/\/$/, '');
  }

  private supabaseKey() {
    return this.configService.get<string>('SUPABASE_SERVICE_ROLE_KEY', '');
  }

  private supabaseJsonHeaders() {
    return {
      Authorization: `Bearer ${this.supabaseKey()}`,
      apikey: this.supabaseKey(),
      'content-type': 'application/json',
    };
  }

  private safeSegment(value: string) {
    const normalized = value.trim();
    if (!normalized || normalized.includes('..') || normalized.includes('/')) {
      throw new BadRequestException('Invalid bucket');
    }
    return normalized;
  }

  private normalizeObjectPath(value: string) {
    const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '').trim();
    if (!normalized || normalized.includes('..')) {
      throw new BadRequestException('Invalid object path');
    }
    return normalized;
  }

  private toResponse(file: StoredFile) {
    return {
      id: file.id,
      provider: file.provider,
      bucket: file.bucket,
      objectPath: file.object_path,
      originalName: file.original_name,
      mimeType: file.mime_type,
      sizeBytes: Number(file.size_bytes),
    };
  }
}
