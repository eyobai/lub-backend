import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppException, ErrorCode } from '../../common/errors/app.exception';
import { APP_CONFIG } from '../../config/configuration';
import type { AppConfig } from '../../config/configuration';
import { detectImage, IMAGE_TYPES } from './image-type';

export interface StoredImage {
  url: string;
  key: string;
  contentType: string;
  sizeBytes: number;
}

/** Stores product pictures in Cloudflare R2 (S3-compatible) and hands back their public address. */
@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);
  private readonly settings: AppConfig['uploads'];
  private readonly client: S3Client | null;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.settings = config.uploads;
    const u = this.settings;
    this.client =
      u.endpoint && u.bucket && u.accessKeyId && u.secretAccessKey && u.publicUrl
        ? new S3Client({
            region: 'auto',
            endpoint: u.endpoint,
            credentials: { accessKeyId: u.accessKeyId, secretAccessKey: u.secretAccessKey },
          })
        : null;
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  get maxBytes(): number {
    return this.settings.maxBytes;
  }

  async storeProductImage(file: { buffer: Buffer; size: number } | undefined): Promise<StoredImage> {
    if (!this.client) {
      throw new AppException(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.UPLOADS_UNAVAILABLE,
        'Picture uploads are not set up on this server. Paste the picture’s address instead.',
      );
    }
    if (!file?.buffer?.length) {
      throw new AppException(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_FAILED, 'Choose a picture to upload');
    }
    if (file.buffer.length > this.settings.maxBytes) {
      throw new AppException(
        HttpStatus.PAYLOAD_TOO_LARGE,
        ErrorCode.PAYLOAD_TOO_LARGE,
        `The picture is larger than ${this.settings.maxBytes / 1024 / 1024} MB`,
      );
    }
    const extension = detectImage(file.buffer);
    if (!extension) {
      throw new AppException(
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        ErrorCode.UNSUPPORTED_IMAGE,
        'Only JPEG, PNG and WebP pictures can be uploaded',
      );
    }
    const now = new Date();
    const key = `products/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${extension}`;
    const contentType = IMAGE_TYPES[extension];
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.settings.bucket,
          Key: key,
          Body: file.buffer,
          ContentType: contentType,
          // The name is unique and never reused, so browsers and the CDN may keep it for good.
          CacheControl: 'public, max-age=31536000, immutable',
        }),
      );
    } catch (error) {
      this.logger.error({ err: error, key }, 'Picture upload to storage failed');
      throw new AppException(
        HttpStatus.BAD_GATEWAY,
        ErrorCode.UPLOAD_FAILED,
        'The picture could not be stored. Try again in a moment.',
      );
    }
    return { url: `${this.settings.publicUrl}/${key}`, key, contentType, sizeBytes: file.buffer.length };
  }
}
