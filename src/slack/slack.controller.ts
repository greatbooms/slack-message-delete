import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common'
import { SlackService } from './slack.service'
import { Request } from 'express'
import { SlackExportService } from './slack-export.service'

@Controller('slack')
export class SlackController {
  constructor(
    private readonly slackService: SlackService,
    private readonly slackExportService: SlackExportService,
  ) {}

  private getUserToken(req: Request): string {
    const token = req.cookies?.slackToken
    if (!token) {
      throw new UnauthorizedException('슬랙 인증이 필요합니다')
    }
    return token
  }

  private getUserId(req: Request): string {
    const userId = req.cookies?.slackUserId
    if (!userId) {
      throw new UnauthorizedException('사용자 ID를 찾을 수 없습니다')
    }
    return userId
  }

  @Post('delete-messages')
  async deleteMessages(
    @Req() req: Request,
    @Body()
    body: {
      channelId: string
      olderThan?: string
      newerThan?: string
      limit?: number
    },
  ) {
    const { channelId, olderThan, newerThan, limit } = body

    if (!channelId) {
      throw new BadRequestException('채널 ID는 필수입니다')
    }

    const userToken = this.getUserToken(req)
    const userId = this.getUserId(req) // 쿠키에서 사용자 ID 가져오기

    return this.slackService.deleteMessages(userToken, channelId, {
      userId,
      olderThan: olderThan ? new Date(olderThan) : undefined,
      newerThan: newerThan ? new Date(newerThan) : undefined,
      limit,
    })
  }

  @Post('delete-all-user-messages')
  async deleteAllUserMessages(
    @Req() req: Request,
    @Body() body: { olderThan?: string; newerThan?: string; limit?: number },
  ) {
    const { olderThan, newerThan, limit } = body

    const userToken = this.getUserToken(req)
    const userId = this.getUserId(req) // 쿠키에서 사용자 ID 가져오기

    return this.slackService.deleteAllUserMessages(userToken, userId, {
      olderThan: olderThan ? new Date(olderThan) : undefined,
      newerThan: newerThan ? new Date(newerThan) : undefined,
      limit,
    })
  }

  @Post('delete-direct-messages')
  async deleteDirectMessages(
    @Req() req: Request,
    @Body() body: { olderThan?: string; newerThan?: string; limit?: number; email?: string },
  ) {
    const { olderThan, newerThan, limit, email } = body

    const userToken = this.getUserToken(req)
    const userId = this.getUserId(req) // 쿠키에서 사용자 ID 가져오기

    this.slackService
      .deleteAllUserDirectMessages(userToken, userId, {
        olderThan: olderThan ? new Date(olderThan) : undefined,
        newerThan: newerThan ? new Date(newerThan) : undefined,
        limit,
      })
      .then(async result => {
        console.log(result)
        if (result.length > 0 && email) {
          let body = ''
          result.forEach(message => {
            body += `채널명 : ${message.name}\n`
            body += `삭제한 메세지 수: ${message.success}\n`
            body += `삭제실패 메세지 수: ${message.failed}\n`
          })

          await this.slackExportService.sendEmail(email, 'slack-delete-messages', body, '')
        }
      })

    return {
      message: '삭제 요청이 완료되었습니다. 결과는 이메일로 발송됩니다.',
    }
  }

  @Post('delete-messages-with-user')
  async deleteMessagesWithUser(
    @Req() req: Request,
    @Body()
    body: {
      otherUserId: string // myUserId는 쿠키에서 자동으로 가져옴
      olderThan?: string
      newerThan?: string
      limit?: number
      email?: string // 결과를 받을 이메일
    },
  ) {
    const { otherUserId, olderThan, newerThan, limit, email } = body

    if (!otherUserId) {
      throw new BadRequestException('상대방 사용자 ID가 필요합니다')
    }

    const userToken = this.getUserToken(req)
    const myUserId = this.getUserId(req) // 쿠키에서 사용자 ID 가져오기

    this.slackService
      .deleteDirectMessagesWithUser(userToken, myUserId, otherUserId, {
        olderThan: olderThan ? new Date(olderThan) : undefined,
        newerThan: newerThan ? new Date(newerThan) : undefined,
        limit,
      })
      .then(async result => {
        if (result.length > 0 && email) {
          let body = ''
          result.forEach(message => {
            body += `채널명 : ${message.name}\n`
            body += `삭제한 메세지 수: ${message.success}\n`
            body += `삭제실패 메세지 수: ${message.failed}\n`
          })

          await this.slackExportService.sendEmail(email, 'slack-delete-messages', body, '')
        }
      })

    return {
      message: '삭제 요청이 완료되었습니다. 결과는 이메일로 발송됩니다.',
    }
  }
}
