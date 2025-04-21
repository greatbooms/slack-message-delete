import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import axios from 'axios'

@Injectable()
export class SlackOauthService {
  private readonly logger = new Logger(SlackOauthService.name)
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly redirectUri: string

  constructor(private configService: ConfigService) {
    this.clientId = this.configService.get<string>('SLACK_CLIENT_ID')
    this.clientSecret = this.configService.get<string>('SLACK_CLIENT_SECRET')
    this.redirectUri = this.configService.get<string>('SLACK_REDIRECT_URI')
  }

  /**
   * 슬랙 OAuth 인증 URL 생성
   */
  getAuthorizationUrl(state: string): string {
    // 메시지 삭제에 필요한 사용자 스코프만 설정
    // 봇 스코프는 필요하지 않음
    const userScopes = [
      'chat:write', // 메시지 삭제를 위해 필요
      'im:history', // DM 메시지 접근을 위해 필요
      'im:read', // DM 채널 조회를 위해 필요
      'channels:history', // 채널 메시지 접근을 위해 필요
      'groups:history', // 비공개 채널 메시지 접근을 위해 필요
      'mpim:history', // 그룹 DM 메시지 접근을 위해 필요
      'mpim:read', // 그룹 DM 채널 조회를 위해 필요
      'users:read', // 사용자 정보 조회를 위해 필요
    ].join(',')

    return `https://slack.com/oauth/v2/authorize?client_id=${this.clientId}&user_scope=${userScopes}&redirect_uri=${encodeURIComponent(this.redirectUri)}&state=${state}`
  }

  /**
   * 인증 코드를 토큰으로 교환
   */
  async exchangeCodeForToken(code: string): Promise<{
    access_token?: string
    user_id?: string
    error?: string
  }> {
    try {
      const response = await axios.post('https://slack.com/api/oauth.v2.access', null, {
        params: {
          client_id: this.clientId,
          client_secret: this.clientSecret,
          code,
          redirect_uri: this.redirectUri,
        },
      })

      const data = response.data

      if (!data.ok) {
        this.logger.error(`Slack OAuth error: ${data.error}`)
        return { error: data.error }
      }

      // Slack OAuth v2 응답에서 사용자 토큰 추출
      // - authed_user.access_token: 사용자 토큰 (xoxp-)
      if (!data.authed_user?.access_token) {
        this.logger.error('사용자 토큰을 받지 못했습니다.')
        return { error: 'user_token_not_found' }
      }

      return {
        access_token: data.authed_user.access_token, // 사용자 토큰만 사용
        user_id: data.authed_user.id, // 인증한 사용자 ID
      }
    } catch (error) {
      this.logger.error(`Slack OAuth token exchange error: ${error.message}`, error.stack)
      return { error: error.message }
    }
  }
}
