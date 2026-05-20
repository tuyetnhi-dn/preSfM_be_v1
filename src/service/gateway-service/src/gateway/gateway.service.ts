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

  async jsonRequest(input: {
    service: ServiceKey;
    path: string;
    method: string;
    body?: unknown;
    authorization?: string;
  }) {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (input.authorization) {
      headers.authorization = input.authorization;
    }
    const response = await fetch(
      `${this.serviceUrl(input.service)}${input.path}`,
      {
        method: input.method,
        headers,
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
      },
    );
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
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
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return this.parseResponse(response);
  }

  async binaryRequest(input: {
    service: ServiceKey;
    path: string;
    method: string;
  }) {
    const response = await fetch(
      `${this.serviceUrl(input.service)}${input.path}`,
      { method: input.method },
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
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const data = contentType.includes('application/json')
      ? await response.json()
      : await response.text();
    if (!response.ok) {
      throw new HttpException(data, response.status);
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return data;
  }
}
