import { ApiProperty } from '@nestjs/swagger';

export class UploadSettingsDto {
  @ApiProperty({ description: 'False while storage is not set up: pictures are then added by address only' })
  enabled!: boolean;

  @ApiProperty({ example: 5242880, description: 'Largest picture accepted, in bytes' })
  maxBytes!: number;

  @ApiProperty({ example: ['image/jpeg', 'image/png', 'image/webp'], type: [String] })
  contentTypes!: string[];
}

export class UploadImageDto {
  @ApiProperty({ type: 'string', format: 'binary', description: 'A JPEG, PNG or WebP picture' })
  file!: unknown;
}

export class UploadedImageDto {
  @ApiProperty({ example: 'https://images.leyubid.com/products/2026/11/2f1c.jpg', description: 'Public address' })
  url!: string;

  @ApiProperty({ example: 'products/2026/11/2f1c.jpg' })
  key!: string;

  @ApiProperty({ example: 'image/jpeg' })
  contentType!: string;

  @ApiProperty({ example: 182044 })
  sizeBytes!: number;
}
