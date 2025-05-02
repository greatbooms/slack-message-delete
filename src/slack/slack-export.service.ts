import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { WebClient } from '@slack/web-api'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as nodemailer from 'nodemailer'
import * as archiver from 'archiver'

@Injectable()
export class SlackExportService {
  private readonly logger = new Logger(SlackExportService.name)
  private readonly emailUser: string
  private readonly emailPass: string
  private readonly emailFrom: string

  constructor(private configService: ConfigService) {
    this.emailUser = this.configService.get<string>('EMAIL_USER')
    this.emailPass = this.configService.get<string>('EMAIL_PASS')
    this.emailFrom = this.configService.get<string>('EMAIL_FROM', this.emailUser)
  }

  // WebClient를 동적으로 생성하는 메서드
  private getWebClient(userToken: string): WebClient {
    return new WebClient(userToken, {
      // 재시도 메커니즘 설정
      retryConfig: {
        retries: 3, // 최대 3회 재시도
        factor: 2, // 지수적 백오프 (2의 제곱으로 증가)
        minTimeout: 2000, // 최소 대기 시간 (2초)
        maxTimeout: 30000, // 최대 대기 시간 (30초)
        randomize: true, // 지터 추가
      },
      // 요청 타임아웃 증가
      timeout: 30000, // 30초
    })
  }

  /**
   * 채널 ID로 채널 이름 조회
   */
  private async getChannelInfo(
    webClient: WebClient,
    channelId: string,
  ): Promise<{ name: string; isIm: boolean }> {
    try {
      // 먼저 public/private 채널 정보 조회 시도
      try {
        const info = await webClient.conversations.info({ channel: channelId })
        if (info.channel) {
          return {
            name: info.channel.name || `channel-${channelId}`,
            isIm: info.channel.is_im || false,
          }
        }
      } catch (error) {
        this.logger.warn(`채널 정보 조회 실패, DM 여부 확인: ${error.message}`)
      }

      // DM 채널인 경우 상대방 사용자 정보 조회
      if (channelId.startsWith('D')) {
        try {
          // DM 채널에서 상대방 사용자 ID 조회
          const history = await webClient.conversations.history({ channel: channelId, limit: 1 })
          if (history.messages && history.messages.length > 0) {
            const message = history.messages[0]
            const userId = message.user

            if (userId) {
              const userInfo = await webClient.users.info({ user: userId })
              if (userInfo.user) {
                return {
                  name: `DM-${userInfo.user.name || userInfo.user.real_name || userId}`,
                  isIm: true,
                }
              }
            }
          }
        } catch (error) {
          this.logger.warn(`DM 상대방 정보 조회 실패: ${error.message}`)
        }
      }

      // 기본 값 반환
      return { name: `unknown-${channelId}`, isIm: false }
    } catch (error) {
      this.logger.error(`채널 정보 조회 중 오류: ${error.message}`, error.stack)
      return { name: `unknown-${channelId}`, isIm: false }
    }
  }

  /**
   * 사용자 ID로 사용자 정보 조회
   */
  private async getUserInfo(
    webClient: WebClient,
    userId: string,
  ): Promise<{ name: string; email: string }> {
    try {
      const response = await webClient.users.info({ user: userId })
      return {
        name: response.user?.real_name || response.user?.name || userId,
        email: response.user?.profile?.email || '',
      }
    } catch (error) {
      this.logger.error(`사용자 정보 조회 중 오류: ${error.message}`, error.stack)
      return { name: userId, email: '' }
    }
  }

  /**
   * 메시지 내용을 파일로 저장
   */
  private async saveMessagesToFile(
    messages: any[],
    userInfo: Map<string, { name: string; email: string }>,
    targetName: string,
  ): Promise<string> {
    // 임시 디렉토리에 파일 생성
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-export-'))
    const fileName = `slack-conversation-${targetName}-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`
    const filePath = path.join(tempDir, fileName)

    // 파일 스트림 생성
    const fileStream = fs.createWriteStream(filePath)

    // 파일 헤더 작성
    fileStream.write(`=== 슬랙 대화 내용 - ${targetName} ===\n`)
    fileStream.write(`추출 시간: ${new Date().toLocaleString()}\n\n`)

    // 메시지 정렬 (시간순)
    messages.sort((a, b) => {
      return parseFloat(a.ts) - parseFloat(b.ts)
    })

    // 메시지 내용 작성
    for (const msg of messages) {
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toLocaleString()
      const userName = userInfo.get(msg.user)?.name || msg.user || '알 수 없음'

      fileStream.write(`[${timestamp}] ${userName}:\n`)
      fileStream.write(`${msg.text || '(내용 없음)'}\n\n`)

      // 쓰레드 메시지가 있으면 추가
      if (msg.thread_ts && msg.replies && msg.replies.length > 0) {
        fileStream.write(`--- 쓰레드 응답 ---\n`)
        for (const reply of msg.replies) {
          const replyTimestamp = new Date(parseFloat(reply.ts) * 1000).toLocaleString()
          const replyUserName = userInfo.get(reply.user)?.name || reply.user || '알 수 없음'

          fileStream.write(`[${replyTimestamp}] ${replyUserName}:\n`)
          fileStream.write(`${reply.text || '(내용 없음)'}\n\n`)
        }
        fileStream.write(`--- 쓰레드 종료 ---\n\n`)
      }
    }

    // 스트림 닫기
    return new Promise((resolve, reject) => {
      fileStream.end(() => {
        this.logger.log(`파일 저장 완료: ${filePath}`)
        resolve(filePath)
      })
      fileStream.on('error', err => {
        this.logger.error(`파일 저장 실패: ${err.message}`)
        reject(err)
      })
    })
  }

  /**
   * 파일을 압축
   */
  private async compressFile(filePath: string): Promise<string> {
    const zipPath = `${filePath}.zip`
    const output = fs.createWriteStream(zipPath)
    const archive = archiver('zip', {
      zlib: { level: 9 }, // 최대 압축률
    })

    return new Promise((resolve, reject) => {
      output.on('close', () => {
        this.logger.log(`압축 완료: ${zipPath}, 크기: ${archive.pointer()} bytes`)
        resolve(zipPath)
      })

      archive.on('error', err => {
        this.logger.error(`압축 실패: ${err.message}`)
        reject(err)
      })

      archive.pipe(output)
      archive.file(filePath, { name: path.basename(filePath) })
      archive.finalize()
    })
  }

  /**
   * 이메일 전송
   */
  private async sendEmail(
    to: string,
    subject: string,
    text: string,
    attachmentPath: string,
  ): Promise<void> {
    // SMTP 트랜스포트 생성
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: this.emailUser,
        pass: this.emailPass,
      },
    })

    // 이메일 옵션 설정
    const mailOptions = {
      from: this.emailFrom,
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

    // 이메일 전송
    return new Promise((resolve, reject) => {
      transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
          this.logger.error(`이메일 전송 실패: ${error.message}`)
          reject(error)
        } else {
          this.logger.log(`이메일 전송 성공: ${info.response}`)
          resolve()
        }
      })
    })
  }

  /**
   * 파일 정리 (임시 파일 삭제)
   */
  private cleanupFiles(filePaths: string[]): void {
    for (const file of filePaths) {
      try {
        fs.unlinkSync(file)
        this.logger.log(`파일 삭제: ${file}`)
      } catch (error) {
        this.logger.warn(`파일 삭제 실패: ${file}, ${error.message}`)
      }
    }

    // 디렉토리가 비어있으면 삭제
    for (const file of filePaths) {
      const dir = path.dirname(file)
      try {
        if (fs.readdirSync(dir).length === 0) {
          fs.rmdirSync(dir)
          this.logger.log(`디렉토리 삭제: ${dir}`)
        }
      } catch (error) {
        this.logger.warn(`디렉토리 삭제 실패: ${dir}, ${error.message}`)
      }
    }
  }

  /**
   * 채널 대화 내용 내보내기
   */
  async exportChannelConversation(
    userToken: string,
    channelId: string,
    userEmail: string,
    options?: {
      olderThan?: Date
      newerThan?: Date
      limit?: number
    },
  ): Promise<{ success: boolean; messageCount: number }> {
    const { olderThan, newerThan, limit = 1000 } = options || {}
    const webClient = this.getWebClient(userToken)

    try {
      // 채널 정보 조회
      const channelInfo = await this.getChannelInfo(webClient, channelId)

      let cursor = null
      let hasMore = true
      const messages = []
      const userInfoMap = new Map<string, { name: string; email: string }>()

      // 메시지 수집
      while (hasMore && messages.length < limit) {
        const result = await webClient.conversations.history({
          channel: channelId,
          limit: 100,
          cursor,
          inclusive: true,
        })

        const fetchedMessages = result.messages || []

        // 필터링 조건 적용
        const filteredMessages = fetchedMessages.filter(msg => {
          const timestamp = new Date(parseFloat(msg.ts) * 1000)

          // 특정 날짜보다 오래된 메시지만 포함
          if (olderThan && timestamp > olderThan) return false

          // 특정 날짜보다 최근 메시지만 포함
          if (newerThan && timestamp < newerThan) return false

          return true
        })

        // 유저 정보 수집
        for (const msg of filteredMessages) {
          if (msg.user && !userInfoMap.has(msg.user)) {
            const info = await this.getUserInfo(webClient, msg.user)
            userInfoMap.set(msg.user, info)
          }

          // 쓰레드 응답이 있는 경우 쓰레드 메시지도 수집
          if (msg.thread_ts) {
            try {
              const threadResult = await webClient.conversations.replies({
                channel: channelId,
                ts: msg.thread_ts,
                limit: 100,
              })

              msg.replies = threadResult.messages || []

              for (const reply of msg.replies) {
                if (reply.user && !userInfoMap.has(reply.user)) {
                  const info = await this.getUserInfo(webClient, reply.user)
                  userInfoMap.set(reply.user, info)
                }
              }
            } catch (error) {
              this.logger.warn(`쓰레드 메시지 조회 실패: ${error.message}`)
              msg.replies = []
            }
          }
        }

        messages.push(...filteredMessages)

        if (messages.length >= limit) {
          messages.length = limit // 최대 메시지 수 제한
          break
        }

        // 다음 페이지 확인
        hasMore = result.has_more && cursor !== result.response_metadata?.next_cursor
        cursor = result.response_metadata?.next_cursor

        if (!hasMore || !cursor) break

        // Rate limiting 방지
        await new Promise(resolve => setTimeout(resolve, 1000))
      }

      if (messages.length === 0) {
        this.logger.warn(`채널 ${channelId}에서 대화 내용을 찾을 수 없습니다.`)
        return { success: false, messageCount: 0 }
      }

      // 메시지를 파일로 저장
      const filePath = await this.saveMessagesToFile(messages, userInfoMap, channelInfo.name)

      // 파일 압축
      const zipPath = await this.compressFile(filePath)

      // 이메일 전송
      await this.sendEmail(
        userEmail,
        `슬랙 대화 내용 - ${channelInfo.name}`,
        `안녕하세요,\n\n요청하신 슬랙 대화 내용을 첨부파일로 보내드립니다.\n\n- 채널명: ${channelInfo.name}\n- 메시지 수: ${messages.length}\n- 추출 일시: ${new Date().toLocaleString()}\n\n감사합니다.`,
        zipPath,
      )

      // 임시 파일 정리
      this.cleanupFiles([filePath, zipPath])

      return { success: true, messageCount: messages.length }
    } catch (error) {
      this.logger.error(`대화 내용 내보내기 중 오류 발생: ${error.message}`, error.stack)
      throw error
    }
  }

  /**
   * 사용자 대화 내용 내보내기
   */
  async exportUserConversation(
    userToken: string,
    userId: string,
    userEmail: string,
    options?: {
      olderThan?: Date
      newerThan?: Date
      limit?: number
    },
  ): Promise<{ success: boolean; messageCount: number }> {
    const webClient = this.getWebClient(userToken)

    try {
      // 사용자 정보 조회
      const userInfo = await this.getUserInfo(webClient, userId)

      // 사용자가 참여한 모든 채널 목록 가져오기
      const { channels } = await webClient.users.conversations({
        user: userId,
        types: 'public_channel,private_channel,im,mpim',
        limit: 1000,
      })

      if (!channels || channels.length === 0) {
        this.logger.warn(`사용자 ${userId}가 참여한 채널을 찾을 수 없습니다.`)
        return { success: false, messageCount: 0 }
      }

      const allMessages = []
      const userInfoMap = new Map<string, { name: string; email: string }>()
      userInfoMap.set(userId, userInfo)

      // 각 채널에서 사용자 메시지 수집
      for (const channel of channels) {
        try {
          let cursor = null
          let hasMore = true

          while (hasMore && allMessages.length < (options?.limit || 1000)) {
            const result = await webClient.conversations.history({
              channel: channel.id,
              limit: 100,
              cursor,
              inclusive: true,
            })

            const fetchedMessages = result.messages || []

            // 사용자 메시지만 필터링
            const userMessages = fetchedMessages.filter(msg => {
              if (msg.user !== userId) return false

              const timestamp = new Date(parseFloat(msg.ts) * 1000)

              // 날짜 필터링
              if (options?.olderThan && timestamp > options.olderThan) return false
              if (options?.newerThan && timestamp < options.newerThan) return false

              return true
            })

            // 채널 정보 추가
            userMessages.forEach(msg => {
              msg.channelId = channel.id
              msg.channelName = channel.name || `channel-${channel.id}`
            })

            // 쓰레드 응답이 있는 경우 쓰레드 메시지도 수집
            for (const msg of userMessages) {
              if (msg.thread_ts) {
                try {
                  const threadResult = await webClient.conversations.replies({
                    channel: channel.id,
                    ts: msg.thread_ts,
                    limit: 100,
                  })

                  // 사용자의 쓰레드 응답만 필터링
                  msg.replies = (threadResult.messages || []).filter(reply => reply.user === userId)

                  // 쓰레드에 참여한 다른 사용자 정보 수집
                  for (const reply of threadResult.messages || []) {
                    if (reply.user && !userInfoMap.has(reply.user)) {
                      const info = await this.getUserInfo(webClient, reply.user)
                      userInfoMap.set(reply.user, info)
                    }
                  }
                } catch (error) {
                  this.logger.warn(`쓰레드 메시지 조회 실패: ${error.message}`)
                  msg.replies = []
                }
              }
            }

            allMessages.push(...userMessages)

            // 다음 페이지 확인
            hasMore = result.has_more && cursor !== result.response_metadata?.next_cursor
            cursor = result.response_metadata?.next_cursor

            if (!hasMore || !cursor) break

            // Rate limiting 방지
            await new Promise(resolve => setTimeout(resolve, 1000))
          }
        } catch (error) {
          this.logger.warn(`채널 ${channel.id} 메시지 조회 실패: ${error.message}`)
        }

        // Rate limiting 방지 - 채널 사이 딜레이
        await new Promise(resolve => setTimeout(resolve, 2000))
      }

      if (allMessages.length === 0) {
        this.logger.warn(`사용자 ${userId}의 메시지를 찾을 수 없습니다.`)
        return { success: false, messageCount: 0 }
      }

      // 제한된 수의 메시지만 선택
      if (options?.limit && allMessages.length > options.limit) {
        allMessages.sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts)) // 최신순 정렬
        allMessages.length = options.limit // 제한
      }

      // 메시지를 파일로 저장
      const filePath = await this.saveMessagesToFile(allMessages, userInfoMap, userInfo.name)

      // 파일 압축
      const zipPath = await this.compressFile(filePath)

      // 이메일 전송
      await this.sendEmail(
        userEmail,
        `슬랙 대화 내용 - 사용자(${userInfo.name})`,
        `안녕하세요,\n\n요청하신 사용자(${userInfo.name})의 슬랙 대화 내용을 첨부파일로 보내드립니다.\n\n- 사용자: ${userInfo.name}\n- 메시지 수: ${allMessages.length}\n- 추출 일시: ${new Date().toLocaleString()}\n\n감사합니다.`,
        zipPath,
      )

      // 임시 파일 정리
      this.cleanupFiles([filePath, zipPath])

      return { success: true, messageCount: allMessages.length }
    } catch (error) {
      this.logger.error(`사용자 대화 내용 내보내기 중 오류 발생: ${error.message}`, error.stack)
      throw error
    }
  }
}
