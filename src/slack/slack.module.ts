import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SlackOauthService } from './slack-oauth.service';
import { SlackOauthController } from './slack-oauth.controller';
import { SlackService } from './slack.service';
import { SlackController } from './slack.controller';
import { SlackExportService } from './slack-export.service';
import { SlackExportController } from './slack-export.controller';

@Module({
  imports: [ConfigModule],
  controllers: [SlackOauthController, SlackController, SlackExportController],
  providers: [SlackOauthService, SlackService, SlackExportService],
  exports: [SlackOauthService, SlackService, SlackExportService],
})
export class SlackModule {}