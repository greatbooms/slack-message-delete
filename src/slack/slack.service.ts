// src/slack/slack.service.ts
import { Injectable, Logger } from '@nestjs/common'
import { WebClient } from '@slack/web-api'

@Injectable()
export class SlackService {
  private readonly logger = new Logger(SlackService.name)

  constructor() {}

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

  async deleteMessages(
    userToken: string,
    channelId: string,
    options?: {
      userId?: string
      olderThan?: Date
      newerThan?: Date
      limit?: number
    },
  ): Promise<{ success: number; failed: number }> {
    const { userId, olderThan, newerThan, limit = 1000 } = options || {}

    let cursor = null
    let hasMore = true
    let success = 0
    let failed = 0

    const webClient = this.getWebClient(userToken)

    try {
      // 메시지 검색 및 삭제 반복
      while (hasMore) {
        // 채널 메시지 조회
        const result = await webClient.conversations.history({
          channel: channelId,
          limit: 100, // 한 번에 최대 100개까지 가져올 수 있음
          cursor,
        })

        const messages = result.messages || []
        hasMore = result.has_more && cursor !== result.response_metadata?.next_cursor
        cursor = result.response_metadata?.next_cursor

        if (messages.length === 0) break

        // 필터링 조건 적용
        const filteredMessages = messages.filter(msg => {
          // 특정 사용자의 메시지만 삭제
          if (userId && msg.user !== userId) return false

          const timestamp = new Date(parseInt(msg.ts) * 1000)

          // 특정 날짜보다 오래된 메시지만 삭제
          if (olderThan && timestamp > olderThan) return false

          // 특정 날짜보다 최근 메시지만 삭제
          return !(newerThan && timestamp < newerThan)
        })

        // 각 메시지 삭제
        for (const msg of filteredMessages) {
          if (success + failed >= limit) {
            hasMore = false
            break
          }

          try {
            await webClient.chat.delete({
              channel: channelId,
              ts: msg.ts,
              as_user: true, // 사용자로서 삭제 (중요)
            })
            success++

            // Rate limiting 방지 - 기본 딜레이
            await new Promise(resolve => setTimeout(resolve, 500))
          } catch (error) {
            // message_not_found 오류는 이미 삭제된 메시지이므로 무시하고 성공으로 간주
            if (error.message && error.message.includes('message_not_found')) {
              this.logger.warn(`이미 삭제된 메시지: ${msg.ts} in ${channelId}`)
              success++ // 이미 삭제되었으므로 성공으로 처리
            } else if (error.message && error.message.includes('rate limiting')) {
              this.logger.warn(`Rate limiting 발생, 더 오래 대기합니다...`)
              // Rate limiting이 발생하면 더 오래 대기 (10초)
              await new Promise(resolve => setTimeout(resolve, 5000))
              // 재시도
              try {
                await webClient.chat.delete({
                  channel: channelId,
                  ts: msg.ts,
                  as_user: true,
                })
                success++
              } catch (retryError) {
                this.logger.error(
                  `재시도 후 메시지 삭제 실패: ${retryError.message}`,
                  retryError.stack,
                )
                failed++
              }
            } else {
              this.logger.error(`메시지 삭제 실패: ${error.message}`, error.stack)
              failed++
            }
          }
        }
      }

      return { success, failed }
    } catch (error) {
      this.logger.error(`메시지 삭제 중 오류 발생: ${error.message}`, error.stack)
      throw error
    }
  }

  async deleteAllUserMessages(
    userToken: string,
    userId: string,
    options?: {
      olderThan?: Date
      newerThan?: Date
      limit?: number
    },
  ): Promise<{ success: number; failed: number }> {
    const webClient = this.getWebClient(userToken)

    try {
      // 사용자가 참여한 모든 채널 목록 가져오기
      const { channels } = await webClient.users.conversations({
        user: userId,
        types: 'public_channel,private_channel,im,mpim',
        limit: 1000,
      })

      let totalSuccess = 0
      let totalFailed = 0

      // 각 채널에서 메시지 삭제
      for (const channel of channels) {
        const result = await this.deleteMessages(userToken, channel.id, {
          userId,
          ...options,
        })

        totalSuccess += result.success
        totalFailed += result.failed
      }

      return { success: totalSuccess, failed: totalFailed }
    } catch (error) {
      this.logger.error(`유저 메시지 삭제 중 오류 발생: ${error.message}`, error.stack)
      throw error
    }
  }

  async deleteAllUserDirectMessages(
    userToken: string,
    userId: string,
    options?: {
      olderThan?: Date
      newerThan?: Date
      limit?: number
    },
  ): Promise<{ name: string; id: string; success: number; failed: number }[]> {
    const webClient = this.getWebClient(userToken)
    const totalChannelNames: { name: string; id: string; success: number; failed: number }[] = []

    try {
      // 사용자의 모든 DM 채널 가져오기 (페이지네이션 적용)
      const allChannels = []
      let cursor = null

      while (true) {
        const response = await webClient.users.conversations({
          user: userId,
          types: 'im,mpim', // 1:1 DM과 그룹 DM 모두 포함
          limit: 100,
          cursor: cursor,
          exclude_archived: false, // archived 채널도 포함
        })

        allChannels.push(...response.channels)
        console.log(`가져온 DM 채널 수: ${response.channels.length}, 누적: ${allChannels.length}`)

        if (!response.response_metadata?.next_cursor) {
          break
        }
        cursor = response.response_metadata.next_cursor
      }

      if (allChannels.length === 0) {
        this.logger.warn(`사용자 ${userId}의 DM 채널을 찾지 못했습니다.`)
        return []
      }

      console.log(`총 ${allChannels.length}개의 DM 채널을 찾았습니다.`)

      // 각 DM 채널에서 메시지 삭제
      for (const channel of allChannels) {
        console.log(
          `채널 ${channel.id} (${channel.is_im ? '개인 DM' : '그룹 DM'})에서 메시지 삭제 시작...`,
        )

        // const result = await this.deleteMessages(userToken, channel.id, {
        //   userId, // 자신의 메시지만 삭제
        //   ...options,
        // })
        const result = {
          success: 0,
          failed: 0,
        }
        totalChannelNames.push({
          name: channel.name,
          id: channel.id,
          success: result.success,
          failed: result.failed,
        })

        console.log(`채널 ${channel.id} 삭제 결과: 성공=${result.success}, 실패=${result.failed}`)

        // Rate limiting 방지를 위한 딜레이 - 채널이 많을수록 더 짧게 (하지만 최소 1초)
        const delayTime = Math.max(1000, Math.min(3000, 10000 / allChannels.length))
        await new Promise(resolve => setTimeout(resolve, delayTime))
      }

      return totalChannelNames
    } catch (error) {
      this.logger.error(`DM 메시지 삭제 중 오류 발생: ${error.message}`, error.stack)
      throw error
    }
  }

  async deleteDirectMessagesWithUser(
    userToken: string,
    myUserId: string,
    otherUserId: string,
    options?: {
      olderThan?: Date
      newerThan?: Date
      limit?: number
    },
  ): Promise<{ name: string; id: string; success: number; failed: number }[]> {
    const webClient = this.getWebClient(userToken)
    const totalChannelNames: { name: string; id: string; success: number; failed: number }[] = []

    try {
      // 사용자의 모든 DM 채널 가져오기 (페이지네이션 적용)
      const allChannels = []
      let cursor = null

      while (true) {
        const response = await webClient.users.conversations({
          types: 'im,mpim', // 1:1 DM과 그룹 DM 모두 포함
          limit: 100,
          cursor: cursor,
          exclude_archived: false, // archived 채널도 포함
        })

        allChannels.push(...response.channels)
        console.log(`가져온 채널 수: ${response.channels.length}, 누적: ${allChannels.length}`)

        if (!response.response_metadata?.next_cursor) {
          break
        }
        cursor = response.response_metadata.next_cursor
      }

      // 찾은 채널 ID들을 저장할 배열
      const targetChannelIds = []

      // conversations.open 메서드를 사용하여 특정 사용자와의 DM 채널 찾기
      try {
        const dmResponse = await webClient.conversations.open({
          users: otherUserId,
          return_im: true,
        })

        if (dmResponse.ok && dmResponse.channel) {
          targetChannelIds.push(dmResponse.channel.id)
          console.log(`Direct channel found: ${dmResponse.channel.id}`)
        }
      } catch (error) {
        console.error(`conversations.open 실패: ${error.message}`)
      }

      // 모든 채널을 순회하면서 특정 사용자가 포함된 채널 찾기
      for (const channel of allChannels) {
        // 이미 찾은 채널은 건너뛰기
        if (targetChannelIds.includes(channel.id)) {
          continue
        }

        // 1:1 DM 채널이면서 상대방이 otherUserId인 경우
        if (channel.is_im && channel.user === otherUserId) {
          targetChannelIds.push(channel.id)
          console.log(`1:1 DM channel found: ${channel.id}`)
          continue
        }

        // 그룹 DM 채널에서 사용자 확인
        if (channel.is_mpim) {
          try {
            // 채널의 멤버 목록 가져오기
            const membersResponse = await webClient.conversations.members({
              channel: channel.id,
            })

            // 특정 사용자가 포함되어 있는지 확인
            if (membersResponse.members && membersResponse.members.includes(otherUserId)) {
              totalChannelNames.push({ name: channel.name, id: channel.id, success: 0, failed: 0 })
              targetChannelIds.push(channel.id)
              console.log(
                `그룹 DM channel found: ${channel.id}, name: ${channel.name || '이름 없음'}`,
              )
            }
          } catch (error) {
            console.error(`채널 멤버 조회 실패: ${error.message}`)
          }
        }
      }

      if (targetChannelIds.length === 0) {
        this.logger.warn(`${otherUserId}와의 DM 채널을 찾지 못했습니다.`)
        return [] // 채널을 찾지 못함
      }

      // 찾은 모든 채널에서 메시지 삭제
      for (const channelId of targetChannelIds) {
        console.log(`채널 ${channelId}에서 메시지 삭제 시작...`)
        const result = await this.deleteMessages(userToken, channelId, {
          userId: myUserId, // 자신의 메시지만 삭제
          ...options,
        })

        totalChannelNames.forEach(channel => {
          if (channel.id === channelId) {
            channel.success = result.success
            channel.failed = result.failed
          }
        })

        console.log(`채널 ${channelId} 삭제 결과: 성공=${result.success}, 실패=${result.failed}`)

        // 채널 간 처리 시 딜레이 추가 (최소 2초)
        await new Promise(resolve => setTimeout(resolve, 2000))
      }

      return totalChannelNames
    } catch (error) {
      this.logger.error(`특정 사용자와의 DM 삭제 중 오류 발생: ${error.message}`, error.stack)
      throw error
    }
  }
}
