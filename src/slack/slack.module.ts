import { Module } from '@nestjs/common'
import { SlackService } from './slack.service'
import { SlackController } from './slack.controller'
import { ConfigModule } from '@nestjs/config'
import { SlackOauthService } from './slack-oauth.service'
import { SlackOauthController } from './slack-oauth.controller'

@Module({
  imports: [ConfigModule.forRoot()],
  controllers: [SlackController, SlackOauthController],
  providers: [SlackService, SlackOauthService],
  exports: [SlackService, SlackOauthService],
})
export class SlackModule {}
