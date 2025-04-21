import { Module } from '@nestjs/common'
import { SlackModule } from './slack/slack.module'
import { ConfigModule } from '@nestjs/config'
import { ServeStaticModule } from '@nestjs/serve-static'
import { join } from 'path'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'public'),
      // 옵션 설정 (필요한 경우)
      serveRoot: '/', // 기본값
      exclude: ['/slack*'], // API 경로는 제외
    }),
    SlackModule,
  ],
})
export class AppModule {}
