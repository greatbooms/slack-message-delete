import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import {
  WebClient,
  ErrorCode,
  WebAPICallError,
  ConversationsHistoryResponse,
  ConversationsRepliesResponse,
  UsersConversationsResponse,
} from '@slack/web-api'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as nodemailer from 'nodemailer'
import * as archiver from 'archiver'

// --- Define custom interfaces for processed data ---

interface UserInfo {
  name: string
  email: string
}

// Interface to hold processed message data including replies and context
interface ProcessedMessage {
  ts: string
  text?: string
  userId?: string // Original user ID from Slack message
  userName: string // Resolved user name
  thread_ts?: string // Indicate if it's part of a thread
  channelId?: string // Optional: For user export context
  channelName?: string // Optional: For user export context
  replies?: ProcessedMessage[] // Embed processed replies directly
  // Add any other original message properties you need here
  // e.g., attachments, blocks, etc. if you plan to export them
}

@Injectable()
export class SlackExportService {
  private readonly logger = new Logger(SlackExportService.name)
  private readonly emailUser: string
  private readonly emailPass: string
  private readonly emailFrom: string

  constructor(private configService: ConfigService) {
    // Consider using environment variable validation (e.g., with Joi)
    this.emailUser = this.configService.getOrThrow<string>('EMAIL_USER')
    this.emailPass = this.configService.getOrThrow<string>('EMAIL_PASS')
    this.emailFrom = this.configService.get<string>('EMAIL_FROM', this.emailUser)
  }

  // Type the WebClient return
  private getWebClient(userToken: string): WebClient {
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
  private isSlackError(error: any): error is WebAPICallError {
    return typeof error === 'object' && error !== null && 'code' in error
  }

  /**
   * 채널 ID로 채널 이름 조회
   */
  private async getChannelInfo(
    webClient: WebClient,
    channelId: string,
  ): Promise<{ id: string; name: string; isIm: boolean }> {
    try {
      const info = await webClient.conversations.info({ channel: channelId })
      if (info.ok && info.channel) {
        return {
          id: info.channel.id!,
          name: info.channel.name || `channel-${channelId}`,
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
  private async resolveDmNameFallback(
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
  private async getUserInfoWithCache(
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
  private async getUserInfo(webClient: WebClient, userId: string): Promise<UserInfo> {
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
   * Process replies for a given thread
   */
  private async processThreadReplies(
    webClient: WebClient,
    channelId: string,
    threadTs: string,
    userInfoCache: Map<string, UserInfo>,
    options?: { filterUserId?: string }, // Optional: only include replies from this user
  ): Promise<ProcessedMessage[]> {
    const processedReplies: ProcessedMessage[] = []
    let cursor: string | undefined = undefined
    let hasMore = true

    while (hasMore) {
      try {
        const threadResult: ConversationsRepliesResponse = await webClient.conversations.replies({
          channel: channelId,
          ts: threadTs,
          limit: 200, // Fetch more replies per call if needed
          cursor: cursor,
        })

        if (threadResult.ok && threadResult.messages) {
          // Skip the first message, it's the parent thread message
          const replies = threadResult.messages.slice(1)

          for (const reply of replies) {
            // Apply user filter if provided
            if (options?.filterUserId && reply.user !== options.filterUserId) {
              continue
            }
            if (!reply.user || !reply.ts) continue // Skip replies without user or timestamp

            const replierInfo = await this.getUserInfoWithCache(
              webClient,
              reply.user,
              userInfoCache,
            )
            processedReplies.push({
              ts: reply.ts,
              text: reply.text,
              userId: reply.user,
              userName: replierInfo.name,
              // Replies don't have further nested replies in this context
            })
          }

          hasMore =
            threadResult.response_metadata?.next_cursor !== undefined &&
            threadResult.response_metadata?.next_cursor !== ''
          cursor = threadResult.response_metadata?.next_cursor
        } else {
          this.logger.warn(
            `conversations.replies not OK for thread ${threadTs} in ${channelId}: ${threadResult.error}`,
          )
          hasMore = false // Stop pagination on error
        }
      } catch (error) {
        this.logger.error(
          `Error fetching replies for thread ${threadTs} in ${channelId}: ${error.message}`,
          error.stack,
        )
        hasMore = false // Stop pagination on error
      }
      // Rate limiting delay between reply pages
      if (hasMore) {
        await new Promise(resolve => setTimeout(resolve, 1200))
      }
    }
    // Sort replies by timestamp ascending
    processedReplies.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts))
    return processedReplies
  }

  /**
   * 메시지 내용을 파일로 저장 (Uses ProcessedMessage)
   */
  private async saveMessagesToFile(
    messages: ProcessedMessage[], // Takes the processed messages
    targetName: string, // Channel name or User name
    baseTempDir?: string, // Optional base temp dir for cleanup
  ): Promise<string> {
    const tempDir = baseTempDir || fs.mkdtempSync(path.join(os.tmpdir(), 'slack-export-'))
    // Sanitize targetName for use in filename
    const safeTargetName = targetName.replace(/[^a-z0-9_\-]/gi, '_').toLowerCase()
    const fileName = `slack-${safeTargetName}-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`
    const filePath = path.join(tempDir, fileName)

    const fileStream = fs.createWriteStream(filePath)

    fileStream.write(`=== Slack Conversation Export - ${targetName} ===\n`)
    if (messages[0]?.channelName) {
      // Add channel context if available (from user export)
      fileStream.write(`Context: Messages involving user ${targetName}\n`)
    }
    fileStream.write(`Export Time: ${new Date().toLocaleString()}\n\n`)

    // Messages should already be sorted before calling this function if needed
    // If not, sort here: messages.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));

    for (const msg of messages) {
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toLocaleString()
      // Add channel name if available (useful for user exports)
      const channelPrefix = msg.channelName ? `[Channel: ${msg.channelName}] ` : ''

      fileStream.write(`[${timestamp}] ${channelPrefix}${msg.userName}:\n`)
      fileStream.write(`${msg.text || '(No text content)'}\n\n`)

      // Write processed thread replies
      if (msg.replies && msg.replies.length > 0) {
        fileStream.write(`--- Thread Replies ---\n`)
        for (const reply of msg.replies) {
          const replyTimestamp = new Date(parseFloat(reply.ts) * 1000).toLocaleString()
          fileStream.write(`  [${replyTimestamp}] ${reply.userName}:\n`)
          fileStream.write(`  ${reply.text || '(No text content)'}\n\n`)
        }
        fileStream.write(`--- End Thread ---\n\n`)
      }
    }

    return new Promise((resolve, reject) => {
      fileStream.end(() => {
        this.logger.log(`Message file saved: ${filePath}`)
        resolve(filePath)
      })
      fileStream.on('error', err => {
        this.logger.error(`Failed to save message file: ${err.message}`)
        reject(err)
      })
    })
  }

  /**
   * **여러 파일**을 하나의 ZIP으로 압축
   * @param filePaths 압축할 파일 경로 배열 (예: ['/tmp/file1.txt', '/tmp/file2.txt'])
   * @param zipFilePath 생성될 최종 ZIP 파일의 전체 경로 (예: '/tmp/final_archive.zip')
   * @returns 생성된 ZIP 파일 경로 Promise
   */
  private async compressFiles(filePaths: string[], zipFilePath: string): Promise<string> {
    // 1. 최종 ZIP 파일을 위한 쓰기 스트림 생성
    const output = fs.createWriteStream(zipFilePath)

    // 2. archiver 인스턴스 생성 (zip 포맷, 최대 압축 레벨)
    const archive = archiver('zip', {
      zlib: { level: 9 }, // Sets the compression level.
    })

    // 3. Promise를 사용하여 비동기 작업 처리
    return new Promise((resolve, reject) => {
      // 4. 이벤트 리스너 설정
      // 'close': ZIP 파일 스트림이 닫혔을 때 (압축 완료)
      output.on('close', () => {
        this.logger.log(
          `Files compressed successfully: ${zipFilePath}, Total size: ${archive.pointer()} bytes`,
        )
        resolve(zipFilePath) // 성공 시 ZIP 파일 경로 반환
      })

      // 'warning': 압축 중 경고 발생 시 (예: 존재하지 않는 파일 추가 시도)
      archive.on('warning', err => {
        this.logger.warn(`Archiver warning: ${err.code}`, err)
        // 경고는 오류가 아니므로 reject하지 않음
      })

      // 'error': 심각한 오류 발생 시
      archive.on('error', err => {
        this.logger.error(`Compression failed: ${err.message}`, err.stack)
        reject(err) // 실패 시 오류 객체 반환
      })

      // 5. 아카이브 파이프 설정: 아카이브 출력을 파일 쓰기 스트림으로 연결
      archive.pipe(output)

      // 6. 입력된 파일 경로 배열 순회하며 각 파일을 아카이브에 추가
      for (const filePath of filePaths) {
        // 파일 존재 여부 확인 (경고 로깅은 archiver에서도 처리하지만, 명시적 확인 가능)
        if (fs.existsSync(filePath)) {
          // archive.file(파일경로, { name: ZIP 내부에서의 파일명 })
          // path.basename(filePath)를 사용하여 전체 경로가 아닌 파일 이름만 ZIP 내부에 저장
          archive.file(filePath, { name: path.basename(filePath) })
          this.logger.debug(`Adding file to archive: ${filePath}`)
        } else {
          // 존재하지 않는 파일은 건너뛰고 경고 로깅
          this.logger.warn(`File not found for zipping, skipping: ${filePath}`)
        }
      }

      // 7. 아카이브 마무리: 모든 파일 추가 완료 후 호출해야 함
      archive.finalize()
    })
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

    const mailOptions = {
      from: `"${this.emailFrom}" <${this.emailUser}>`, // Nicer From address
      to,
      subject,
      text,
      attachments: [
        {
          filename: path.basename(attachmentPath),
          path: attachmentPath,
        },
      ],
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

  /**
   * 파일 정리 (임시 파일 및 디렉토리 삭제)
   * @param filePaths 생성된 모든 임시 파일 경로 (텍스트 파일 + ZIP 파일)
   * @param baseTempDir 삭제할 기본 임시 디렉토리
   */
  private cleanupFiles(filePaths: string[], baseTempDir: string | null): void {
    for (const file of filePaths) {
      try {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file)
          this.logger.log(`Deleted temp file: ${file}`)
        } else {
          // It's ok if the zip file wasn't created due to an earlier error
          this.logger.warn(
            `Temp file not found for deletion (might be expected if error occurred earlier): ${file}`,
          )
        }
      } catch (error: any) {
        this.logger.warn(`Failed to delete temp file: ${file}, ${error.message}`)
      }
    }

    // 기본 임시 디렉토리 삭제 시도
    if (baseTempDir && fs.existsSync(baseTempDir)) {
      try {
        // Use recursive delete for potentially non-empty dirs due to unforeseen errors or files
        fs.rmSync(baseTempDir, { recursive: true, force: true }) // Node.js v14.14+
        this.logger.log(`Deleted base temp directory: ${baseTempDir}`)
      } catch (error: any) {
        this.logger.error(`Failed to delete base temp directory: ${baseTempDir}, ${error.message}`)
      }
    }
  }

  // --- Main Export Functions ---

  /**
   * 사용자 대화 내용 내보내기
   */
  async exportUserConversation(
    userToken: string,
    targetId: string,
    userEmail: string,
    options?: {
      oldest?: string // Slack API uses 'oldest' (seconds.microseconds)
      latest?: string // Slack API uses 'latest'
      targetType?: 'channel' | 'user' // Type of target (channel or user)
      limit?: number // Limit total messages across all channels
    },
  ): Promise<{ success: boolean; messageCount: number }> {
    const { oldest, latest, limit = 1000 } = options || {}
    const webClient = this.getWebClient(userToken)
    const userInfoCache = new Map<string, UserInfo>()
    const allFilePaths: string[] = [] // Track all file paths for cleanup
    let baseTempDir: string | null = null // Single temp dir for the whole operation
    let finalZipPath: string | null = null // Path to the final zip file

    try {
      baseTempDir = fs.mkdtempSync(path.join(os.tmpdir(), `slack-user-${targetId}-`))
      let convCursor: string | undefined = undefined
      let moreConvs = true
      const channelsToProcess: { id: string; name: string }[] = []
      let totalMessages = 0
      let targetName = ''

      if (options.targetType === 'channel') {
        const channelInfo = await this.getChannelInfo(webClient, targetId)
        targetName = channelInfo.name
        this.logger.log(`Starting export for channel: ${targetName} (${targetId})`)
        channelsToProcess.push({
          id: channelInfo.id,
          name: channelInfo.name || `channel-${channelInfo.id}`,
        })
      } else if (options.targetType === 'user') {
        const targetUserInfo = await this.getUserInfoWithCache(webClient, targetId, userInfoCache) // Cache the target user
        targetName = targetUserInfo.name
        this.logger.log(`Starting export for user: ${targetName} (${targetId})`)
        while (moreConvs) {
          try {
            const convResult: UsersConversationsResponse = await webClient.users.conversations({
              user: targetId,
              types: 'im,mpim',
              limit: 200, // Fetch more conversations per page
              cursor: convCursor,
            })

            if (convResult.ok && convResult.channels) {
              convResult.channels.forEach(ch => {
                if (ch.id) {
                  // Ensure channel has an ID
                  channelsToProcess.push({ id: ch.id, name: ch.name || `channel-${ch.id}` })
                }
              })
              moreConvs =
                convResult.response_metadata?.next_cursor !== undefined &&
                convResult.response_metadata?.next_cursor !== ''
              convCursor = convResult.response_metadata?.next_cursor
            } else {
              this.logger.error(`users.conversations not OK for ${targetId}: ${convResult.error}`)
              moreConvs = false
            }
          } catch (error) {
            this.logger.error(
              `Error fetching conversations for ${targetId}: ${error.message}`,
              error.stack,
            )
            moreConvs = false
          }
          if (moreConvs) {
            await new Promise(resolve => setTimeout(resolve, 1200))
          }
        }
      } else {
        this.logger.error(`Invalid targetType: ${options.targetType}`)
        return { success: false, messageCount: 0 }
      }

      if (channelsToProcess.length === 0) {
        this.logger.warn(
          `User ${targetName} (${targetId}) is not part of any accessible conversations.`,
        )
        return { success: false, messageCount: 0 }
      }

      this.logger.log(
        `User ${targetName} found in ${channelsToProcess.length} conversations. Fetching messages...`,
      )

      // 2. Iterate through channels and fetch user's messages
      for (const channel of channelsToProcess) {
        let msgCursor: string | undefined = undefined
        let hasMoreMsgs = true
        const allProcessedMessages: ProcessedMessage[] = []
        this.logger.debug(
          `Workspaceing messages for user ${targetId} in channel ${channel.name} (${channel.id})`,
        )

        while (hasMoreMsgs) {
          try {
            const historyResult: ConversationsHistoryResponse =
              await webClient.conversations.history({
                channel: channel.id,
                limit: 100,
                cursor: msgCursor,
                oldest: oldest,
                latest: latest,
                inclusive: true,
              })

            if (historyResult.ok && historyResult.messages) {
              for (const msg of historyResult.messages) {
                if (allProcessedMessages.length >= limit) {
                  hasMoreMsgs = false
                  break // Stop processing if limit reached
                }
                if (!msg.ts) continue // Skip messages without timestamp

                let replies: ProcessedMessage[] | undefined = undefined
                if (msg.thread_ts && msg.thread_ts === msg.ts) {
                  // Fetch ONLY the target user's replies in this thread
                  replies = await this.processThreadReplies(
                    webClient,
                    channel.id,
                    msg.thread_ts,
                    userInfoCache,
                  )
                }

                const userName = await this.getUserInfoWithCache(webClient, msg.user, userInfoCache)
                let message = msg.text
                if (msg.files) {
                  message += '\n\n--- Files ---\n'
                  for (const file of msg.files) {
                    message += `File: ${file.name} (${file.url_private})\n`
                  }
                }

                allProcessedMessages.push({
                  ts: msg.ts,
                  text: message,
                  userId: msg.user,
                  userName: userName!.name,
                  channelId: channel.id, // Add channel context
                  channelName: channel.name, // Add channel context
                  thread_ts: msg.thread_ts,
                  replies: replies,
                })
              } // end for loop over messages

              hasMoreMsgs = historyResult.has_more ?? false
              msgCursor = historyResult.response_metadata?.next_cursor
            } else {
              this.logger.warn(
                `conversations.history not OK for ${channel.id}: ${historyResult.error}`,
              )
              hasMoreMsgs = false
            }
          } catch (error) {
            // Handle channel-specific errors (e.g., not_in_channel) gracefully
            // Check for PlatformError *before* accessing error.data
            if (
              this.isSlackError(error) &&
              error.code === ErrorCode.PlatformError &&
              error.data?.error === 'not_in_channel'
            ) {
              this.logger.warn(
                `Skipping channel ${channel.name} (${channel.id}): Bot/User not a member.`,
              )
            } else {
              // Log other errors (including non-platform Slack errors or other exceptions)
              this.logger.error(
                `Error fetching history for ${channel.id}: ${error.message}`,
                error.stack,
              )
            }
            hasMoreMsgs = false // Stop pagination for this channel on error
          }
          // Rate limiting delay
          if (hasMoreMsgs) {
            await new Promise(resolve => setTimeout(resolve, 1000))
          }
        } // end while hasMoreMsgs
        // Add a small delay between channels
        await new Promise(resolve => setTimeout(resolve, 500))

        if (allProcessedMessages.length === 0) {
          this.logger.warn(
            `No messages found for user ${targetName} (${targetId}) matching criteria across all channels.`,
          )
          continue // Skip to next channel
        }

        // Sort all collected messages chronologically
        allProcessedMessages.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts))

        totalMessages += allProcessedMessages.length

        // 3. Save, Compress, Email, Cleanup
        const filePath = await this.saveMessagesToFile(
          allProcessedMessages,
          `${channel.name}(${channel.id})`,
          baseTempDir,
        )

        allFilePaths.push(filePath) // Track for cleanup
      } // end for loop over channels

      if (totalMessages === 0) {
        this.cleanupFiles([], baseTempDir) // Cleanup empty dir
        this.logger.warn(
          `No messages found for user ${targetName} (${targetId}) matching criteria.`,
        )
        return { success: false, messageCount: 0 }
      }

      const safeUserName = targetName.replace(/[^a-z0-9_\-]/gi, '_').toLowerCase()
      const zipFileName = `slack-user-${safeUserName}-export-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`
      const zipFilePath = path.join(baseTempDir, zipFileName) // Place ZIP in the base temp dir too

      finalZipPath = await this.compressFiles(allFilePaths, zipFilePath)

      await this.sendEmail(
        userEmail,
        `Slack Conversation Export - ${options.targetType === 'user' ? 'USER' : 'CHANNEL'} (${targetName}) - ${allFilePaths.length} Channels`,
        '',
        finalZipPath,
      )

      // 5. Cleanup all temp files and the directory
      this.cleanupFiles([...allFilePaths, finalZipPath], baseTempDir)

      this.logger.log(`Successfully exported ${totalMessages} messages for user ${targetName}.`)
      return { success: true, messageCount: totalMessages }
    } catch (error) {
      this.cleanupFiles([], baseTempDir) // Cleanup empty dir
      this.logger.error(
        `Failed to export conversations for user ${targetId}: ${error.message}`,
        error.stack,
      )
      // Consider cleanup here too
      return { success: false, messageCount: 0 }
    }
  }
}
