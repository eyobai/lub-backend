import { Controller, Get, HttpCode, HttpStatus, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { ErrorResponseDto } from '../../common/dto/error-response.dto';
import { UploadedImageDto, UploadImageDto, UploadSettingsDto } from './dto/upload.dto';
import { IMAGE_TYPES } from './image-type';
import { UploadsService } from './uploads.service';

const error = (description: string) => ({ description, type: ErrorResponseDto });
/** Kept in memory (no `dest`), never written to the server's disk. Multer's own ceiling; the configured, usually smaller, limit is checked by the service. */
const HARD_LIMIT_BYTES = 20 * 1024 * 1024;

@ApiTags('Admin: Uploads')
@ApiBearerAuth()
@ApiUnauthorizedResponse(error('UNAUTHORIZED'))
@ApiForbiddenResponse(error('FORBIDDEN — the signed-in user lacks the required role'))
@Controller('admin/uploads')
export class AdminUploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Get('settings')
  @Roles(RoleName.ADMIN)
  @ApiOperation({ summary: 'Whether picture uploads are available', description: 'Role: ADMIN.' })
  @ApiOkResponse({ type: UploadSettingsDto })
  settings(): UploadSettingsDto {
    return {
      enabled: this.uploads.enabled,
      maxBytes: this.uploads.maxBytes,
      contentTypes: Object.values(IMAGE_TYPES),
    };
  }

  @Post('images')
  @HttpCode(HttpStatus.CREATED)
  @Roles(RoleName.ADMIN)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: HARD_LIMIT_BYTES, files: 1 } }))
  @ApiOperation({
    summary: 'Upload a product picture',
    description:
      'Role: ADMIN. Multipart form with one `file` field: a JPEG, PNG or WebP picture. Stores it and returns its ' +
      'public address, to put in a product’s images.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UploadImageDto })
  @ApiCreatedResponse({ type: UploadedImageDto })
  @ApiBadRequestResponse(error('VALIDATION_FAILED — no file'))
  @ApiPayloadTooLargeResponse(error('PAYLOAD_TOO_LARGE'))
  @ApiUnsupportedMediaTypeResponse(error('UNSUPPORTED_IMAGE — not a JPEG, PNG or WebP picture'))
  @ApiServiceUnavailableResponse(error('UPLOADS_UNAVAILABLE — storage is not set up'))
  @ApiBadGatewayResponse(error('UPLOAD_FAILED — the storage service refused or did not answer'))
  upload(@UploadedFile() file: { buffer: Buffer; size: number } | undefined): Promise<UploadedImageDto> {
    return this.uploads.storeProductImage(file);
  }
}
