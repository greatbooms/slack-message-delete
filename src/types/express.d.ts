import { Session } from 'express-session'

declare module 'express' {
  interface Request {
    session: Session & {
      slackOauthState?: string
      slackToken?: string
      slackUserId?: string
      slackBotToken?: string
    }
  }
}
