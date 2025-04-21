// src/slack/slack.controller.ts
import { Controller, Get, Logger, Query, Req, Res, UnauthorizedException } from '@nestjs/common'
import { Request, Response } from 'express'
import { SlackOauthService } from './slack-oauth.service'
import { v4 as uuidv4 } from 'uuid'

@Controller('slack')
export class SlackOauthController {
  private readonly logger = new Logger(SlackOauthController.name)

  constructor(private readonly slackOauthService: SlackOauthService) {}

  @Get('oauth/login')
  async login(@Res() res: Response, @Req() req: Request) {
    // CSRF 방지를 위한 state 생성
    const state = uuidv4()

    // state를 쿠키에 저장 (secure와 httpOnly 옵션 사용)
    res.cookie('slackOauthState', state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 15 * 60 * 1000, // 15분
      path: '/',
    })

    console.log(`Cookie state: ${state}`)

    // 슬랙 인증 URL로 리다이렉트
    const authUrl = this.slackOauthService.getAuthorizationUrl(state)
    return res.redirect(authUrl)
  }

  @Get('oauth/callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      // 에러 확인
      if (error) {
        this.logger.error(`Slack OAuth error: ${error}`)
        return res.redirect('/auth/error?message=slack_oauth_denied')
      }

      // 쿠키에서 state 값 가져오기
      const cookieState = req.cookies?.slackOauthState

      // CSRF 방지를 위한 state 검증
      if (!cookieState || cookieState !== state) {
        throw new UnauthorizedException('Invalid state parameter')
      }

      // state 쿠키 삭제
      res.clearCookie('slackOauthState')

      // 코드를 토큰으로 교환
      const tokenResult = await this.slackOauthService.exchangeCodeForToken(code)

      if (tokenResult.error) {
        return res.redirect(`/auth/error?message=${tokenResult.error}`)
      }

      if (!tokenResult.access_token || !tokenResult.access_token.startsWith('xoxp-')) {
        this.logger.error('사용자 토큰을 받지 못했습니다. 메시지 삭제 기능이 작동하지 않을 수 있습니다.');
        return res.redirect('/auth/error?message=user_token_required');
      }

      // 사용자 토큰만 쿠키에 저장 (1일 유효기간)
      res.cookie('slackToken', tokenResult.access_token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000, // 1일
        path: '/',
      })

      res.cookie('slackUserId', tokenResult.user_id, {
        httpOnly: false, // 클라이언트 측에서 읽을 수 있도록
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000, // 1일
        path: '/',
      })

      // 인증 상태를 나타내는 추가 쿠키 설정
      res.cookie('slackAuthenticated', 'true', {
        httpOnly: false, // 클라이언트 측에서 읽을 수 있도록
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000, // 1일
        path: '/',
      })

      // 메인 페이지로 리다이렉트
      return res.redirect('/')
    } catch (e) {
      this.logger.error(`Slack OAuth callback error: ${e.message}`, e.stack)
      return res.redirect('/auth/error?message=server_error')
    }
  }
}
