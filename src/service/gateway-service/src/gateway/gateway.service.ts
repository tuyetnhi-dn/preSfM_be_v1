import { HttpException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

type ServiceKey =
  | 'auth'
  | 'video'
  | 'storage'
  | 'opensfm'
  | 'evaluation'
  | 'mask';

@Injectable()
export class GatewayService {
  constructor(private readonly configService: ConfigService) {}

  serviceUrl(key: ServiceKey) {
    const defaults: Record<ServiceKey, string> = {
      auth: 'http://auth-service:8001',
      mask: 'http://segmentation-service:8002',
      video: 'http://video-service:8003',
      storage: 'http://storage-service:8004',
      opensfm: 'http://opensfm-service:8005',
      evaluation: 'http://evaluation-service:8006',
    };

    const envKey = `${key.toUpperCase()}_SERVICE_URL`;

    return this.configService
      .get<string>(envKey, defaults[key])
      .replace(/\/$/, '');
  }

  private buildUrl(input: {
    service: ServiceKey;
    path: string;
    query?: Record<string, string | number | boolean | undefined | null>;
  }) {
    const baseUrl = this.serviceUrl(input.service);
    const url = new URL(input.path, baseUrl);

    Object.entries(input.query ?? {}).forEach(([key, value]) => {
      if (value === undefined || value === null) return;

      const normalizedValue = String(value).trim();

      if (!normalizedValue) return;

      url.searchParams.set(key, normalizedValue);
    });

    return url.toString();
  }

  async jsonRequest(input: {
    service: ServiceKey;
    path: string;
    method: string;
    body?: unknown;
    headers?: Record<string, string>;
    authorization?: string;
    query?: Record<string, string | number | boolean | undefined | null>;
  }) {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      'cache-control': 'no-store',
      pragma: 'no-cache',
    };

    /**
     * Giữ compatibility với code cũ:
     * - Một số route truyền authorization bằng input.authorization
     * - Một số route truyền qua input.headers.authorization
     */
    if (input.headers) {
      Object.assign(headers, input.headers);
    }

    if (input.authorization) {
      headers.authorization = input.authorization;
    }

    const url = this.buildUrl({
      service: input.service,
      path: input.path,
      query: input.query,
    });

    const response = await fetch(url, {
      method: input.method,
      headers,
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
    });

    return this.parseResponse(response);
  }

  async multipartUpload(input: {
    service: ServiceKey;
    path: string;
    file: Express.Multer.File;
    fields: Record<string, string | undefined>;
  }) {
    const formData = new FormData();

    formData.append(
      'file',
      new Blob([input.file.buffer as unknown as BlobPart], {
        type: input.file.mimetype,
      }),
      input.file.originalname,
    );

    for (const [key, value] of Object.entries(input.fields)) {
      if (value !== undefined && value !== null) {
        formData.append(key, value);
      }
    }

    const response = await fetch(
      `${this.serviceUrl(input.service)}${input.path}`,
      {
        method: 'POST',
        body: formData,
      },
    );

    return this.parseResponse(response);
  }

  async binaryRequest(input: {
    service: ServiceKey;
    path: string;
    method: string;
  }) {
    const response = await fetch(
      `${this.serviceUrl(input.service)}${input.path}`,
      {
        method: input.method,
        headers: {
          'cache-control': 'no-store',
          pragma: 'no-cache',
        },
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new HttpException(errorText, response.status);
    }

    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      contentType:
        response.headers.get('content-type') || 'application/octet-stream',
      contentDisposition: response.headers.get('content-disposition') || null,
    };
  }

  private async parseResponse(response: Response) {
    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();

    let data: string | Record<string, any> | null = null;

    if (text) {
      if (contentType.includes('application/json')) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          data = JSON.parse(text);
        } catch {
          data = {
            message: text,
          };
        }
      } else {
        data = text;
      }
    }

    if (!response.ok) {
      throw new HttpException(data ?? '', response.status);
    }

    return data;
  }
}
