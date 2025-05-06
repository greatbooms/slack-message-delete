import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { WebClient, ErrorCode, WebAPICallError } from '@slack/web-api'
import * as nodemailer from 'nodemailer'
import * as path from 'path'

// --- Define interfaces for common functions ---
export interface UserInfo {
  name: string
  email: string
}

@Injectable()
export class SlackUtilsService {
  private readonly logger = new Logger(SlackUtilsService.name)
  private readonly emailUser: string
  private readonly emailPass: string
  private readonly emailFrom: string

  constructor(private configService: ConfigService) {
    this.emailUser = this.configService.getOrThrow<string>('EMAIL_USER')
    this.emailPass = this.configService.getOrThrow<string>('EMAIL_PASS')
    this.emailFrom = this.configService.get<string>('EMAIL_FROM', this.emailUser)
  }

  // Type the WebClient return
  getWebClient(userToken: string): WebClient {
    return new WebClient(userToken, {
      retryConfig: {
        retries: 3,
        factor: 2,
        minTimeout: 2000,
        maxTimeout: 30000,
        randomize: true,
      },
      timeout: 30000,
    })
  }

  // Helper to check for Slack API Errors
  isSlackError(error: any): error is WebAPICallError {
    return typeof error === 'object' && error !== null && 'code' in error
  }

  /**
   * 채널 ID로 채널 이름 조회
   */
  async getChannelInfo(
    webClient: WebClient,
    channelId: string,
  ): Promise<{ id: string; name: string; isIm: boolean }> {
    try {
      const info = await webClient.conversations.info({ channel: channelId })
      if (info.ok && info.channel) {
        let name = info.channel.name
        if (!info.channel.name && info.channel['user']) {
          const userInfo = await this.getUserInfoWithCache(
            webClient,
            info.channel['user'],
            new Map<string, UserInfo>(),
          )
          name = `DM-${userInfo.name}`
        }
        return {
          id: info.channel.id!,
          name: name,
          isIm: info.channel.is_im || false,
        }
      } else {
        // Handle cases like restricted channels if needed
        this.logger.warn(`conversations.info not OK for ${channelId}: ${info.error}`)
        // Fallback attempt for DM name resolution (less reliable)
        return await this.resolveDmNameFallback(webClient, channelId)
      }
    } catch (error) {
      if (this.isSlackError(error) && error.code === ErrorCode.PlatformError) {
        // Platform errors often contain useful data
        this.logger.error(
          `Slack Platform Error getting channel info for ${channelId}: ${error.data.error}`,
          error.stack,
        )
        // If it's a DM channel where info failed, try fallback
        if (channelId.startsWith('D')) {
          return await this.resolveDmNameFallback(webClient, channelId)
        }
      } else {
        this.logger.error(
          `Error getting channel info for ${channelId}: ${error.message}`,
          error.stack,
        )
      }
      return { id: channelId, name: `unknown-${channelId}`, isIm: false }
    }
  }

  // Fallback for DM name resolution if conversations.info fails
  async resolveDmNameFallback(
    webClient: WebClient,
    channelId: string,
  ): Promise<{ id: string; name: string; isIm: boolean }> {
    this.logger.log(`Attempting DM name fallback for ${channelId}`)
    try {
      // Fetch a single message to find the other user
      const history = await webClient.conversations.history({ channel: channelId, limit: 1 })
      if (history.ok && history.messages && history.messages.length > 0) {
        const message = history.messages[0]
        // Find the user ID that is NOT the bot/app user (if applicable)
        // This logic might need refinement based on your app's user context
        const otherUserId = message.user || message.bot_id // Simplistic assumption

        if (otherUserId) {
          const userInfo = await this.getUserInfo(webClient, otherUserId) // Reuse user info logic
          return {
            id: channelId,
            name: `DM-${userInfo.name}`, // Use resolved name
            isIm: true,
          }
        }
      }
    } catch (error) {
      this.logger.warn(`DM name fallback failed for ${channelId}: ${error.message}`)
    }
    return { id: channelId, name: `DM-unknown-${channelId}`, isIm: true } // Assume IM=true if starts with D
  }

  /**
   * 사용자 ID로 사용자 정보 조회 (with Cache)
   */
  async getUserInfoWithCache(
    webClient: WebClient,
    userId: string,
    userInfoCache: Map<string, UserInfo>,
  ): Promise<UserInfo> {
    if (userInfoCache.has(userId)) {
      return userInfoCache.get(userId)!
    }

    try {
      const response = await webClient.users.info({ user: userId })
      if (response.ok && response.user) {
        const userInfo: UserInfo = {
          name: response.user.real_name || response.user.name || `user-${userId}`,
          email: response.user.profile?.email || '',
        }
        userInfoCache.set(userId, userInfo)
        return userInfo
      } else {
        this.logger.warn(`users.info not OK for ${userId}: ${response.error}`)
        const fallbackInfo: UserInfo = { name: `unknown-${userId}`, email: '' }
        userInfoCache.set(userId, fallbackInfo) // Cache fallback to avoid refetching failures
        return fallbackInfo
      }
    } catch (error) {
      if (this.isSlackError(error) && error.code === ErrorCode.PlatformError) {
        this.logger.error(
          `Slack Platform Error getting user info for ${userId}: ${error.data.error}`,
          error.stack,
        )
      } else {
        this.logger.error(`Error getting user info for ${userId}: ${error.message}`, error.stack)
      }
      const fallbackInfo: UserInfo = { name: `unknown-${userId}`, email: '' }
      userInfoCache.set(userId, fallbackInfo)
      return fallbackInfo
    }
  }

  // Keep the original getUserInfo if needed elsewhere, or refactor calls to use the cached version
  async getUserInfo(webClient: WebClient, userId: string): Promise<UserInfo> {
    // This could internally use a temporary cache or just call the API directly
    try {
      const response = await webClient.users.info({ user: userId })
      if (response.ok && response.user) {
        return {
          name: response.user.real_name || response.user.name || `user-${userId}`,
          email: response.user.profile?.email || '',
        }
      } else {
        this.logger.warn(`users.info not OK for ${userId}: ${response.error}`)
        return { name: `unknown-${userId}`, email: '' }
      }
    } catch (error) {
      this.logger.error(`Error getting user info for ${userId}: ${error.message}`, error.stack)
      return { name: `unknown-${userId}`, email: '' }
    }
  }

  /**
   * 이메일 전송
   */
  async sendEmail(
    to: string,
    subject: string,
    text: string,
    attachmentPath: string,
  ): Promise<void> {
    if (!this.emailUser || !this.emailPass) {
      this.logger.error('Email credentials are not configured. Cannot send email.')
      throw new Error('Email service not configured.')
    }
    const transporter = nodemailer.createTransport({
      service: 'gmail', // Consider making this configurable
      auth: {
        user: this.emailUser,
        pass: this.emailPass,
      },
    })

    const mailOptions: any = {
      from: `"${this.emailFrom}" <${this.emailUser}>`, // Nicer From address
      to,
      subject,
      text,
    }

    // 첨부 파일이 있는 경우만 추가
    if (attachmentPath) {
      mailOptions.attachments = [
        {
          filename: path.basename(attachmentPath),
          path: attachmentPath,
        },
      ]
    }

    try {
      const info = await transporter.sendMail(mailOptions)
      this.logger.log(`Email sent successfully: ${info.response}`)
    } catch (error) {
      this.logger.error(`Email sending failed: ${error.message}`)
      // Depending on requirements, you might want to retry or handle this differently
      throw error // Re-throw to indicate failure
    }
  }
}
