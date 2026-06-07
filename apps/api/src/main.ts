import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  // Permissive CORS: the desktop app calls this API cross-origin with a Bearer token.
  // The web build is same-origin behind the gateway, so this is only load-bearing for desktop.
  app.enableCors({
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });
  const port = Number(process.env.CCB_API_PORT ?? 9320);
  await app.listen(port, '0.0.0.0');
  console.log(`[ccb-api] listening on :${port}`);
}

void bootstrap();
