import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common'
import { Request } from 'express'
import { SlackExportService } from './slack-export.service'

@Controller('slack')
export class SlackExportController {
  constructor(private readonly slackExportService: SlackExportService) {}

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

  @Post('export-conversation')
  async exportConversation(
    @Req() req: Request,
    @Body()
    body: {
      targetType: 'channel' | 'user' // 채널 또는 사용자 구분
      targetId: string // 채널 ID 또는 사용자 ID
      email: string // 결과를 받을 이메일
      olderThan?: string
      newerThan?: string
      limit?: number
    },
  ) {
    const { targetType, targetId, email, olderThan, newerThan, limit } = body

    if (!targetId) {
      throw new BadRequestException('대상 ID는 필수입니다')
    }

    if (!email) {
      throw new BadRequestException('이메일 주소는 필수입니다')
    }

    // 이메일 형식 검증
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      throw new BadRequestException('유효한 이메일 주소를 입력해주세요')
    }

    const userToken = this.getUserToken(req)

    const options = {
      olderThan: olderThan ? new Date(olderThan) : undefined,
      newerThan: newerThan ? new Date(newerThan) : undefined,
      limit,
    }

    if (targetType === 'channel') {
      return this.slackExportService.exportChannelConversation(userToken, targetId, email, options)
    } else if (targetType === 'user') {
      return this.slackExportService.exportUserConversation(userToken, targetId, email, options)
    } else {
      throw new BadRequestException('targetType은 "channel" 또는 "user"여야 합니다')
    }
  }
}
