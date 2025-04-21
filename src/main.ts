import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import * as cookieParser from 'cookie-parser';
import { join } from 'path'
import { NestExpressApplication } from '@nestjs/platform-express'

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule)

  app.use(cookieParser())

  // 정적 파일 서빙 설정
  app.useStaticAssets(join(__dirname, '..', 'public'))
  app.setBaseViewsDir(join(__dirname, '..', 'views'))
  app.setViewEngine('hbs')

  // CORS 설정 (필요한 경우)
  app.enableCors({
    origin: process.env.ALLOWED_ORIGINS || '*',
    credentials: true,
  })

  await app.listen(process.env.PORT ?? 3000)
}

bootstrap().then(() => {
  console.log(`Application is running on: ${process.env.PORT ?? 3000}`)
})
