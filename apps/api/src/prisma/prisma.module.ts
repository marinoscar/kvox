import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { PrismaSystemService } from './prisma-system.service';

@Global()
@Module({
  providers: [PrismaService, PrismaSystemService],
  exports: [PrismaService, PrismaSystemService],
})
export class PrismaModule {}
