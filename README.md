# Slack Message Delete

슬랙 메시지를 간편하게 삭제할 수 있는 웹 애플리케이션입니다. 이 애플리케이션을 사용하면 개인 메시지, 채널 메시지 등을 쉽게 삭제할 수 있습니다.

## 주요 기능

[//]: # (- 특정 채널의 메시지 삭제)
[//]: # (- 사용자의 모든 메시지 삭제)
- DM(다이렉트 메시지) 삭제
- 특정 사용자와의 DM 메시지만 삭제
- 날짜 기준 필터링 삭제(특정 날짜 이전/이후 메시지)

## 설치 방법

### 사전 요구사항

- Node.js (v16 이상)
- npm 또는 yarn
- Slack 앱 생성 권한 (워크스페이스 관리자)

### 1. 프로젝트 클론 및 패키지 설치

```bash
# 프로젝트 복제
git clone <repository-url>
cd slack-message-delete

# 패키지 설치
npm install
# 또는
yarn install
```

### 2. Slack 앱 설정

이 애플리케이션을 사용하려면 Slack API를 통해 인증하기 위한 Slack 앱을 생성해야 합니다.

1. [Slack API 사이트](https://api.slack.com/apps)에 접속하여 새 앱 생성
2. "Create New App" 클릭 > "From scratch" 선택
3. 앱 이름과 워크스페이스 선택
4. 앱 설정에서 다음 항목을 구성:

#### OAuth & Permissions 설정

1. "OAuth & Permissions" 페이지로 이동
2. "Redirect URLs"에 다음 URL 추가:
   - `http://localhost:3000/slack/oauth/callback` (개발 환경)
   - 또는 실제 배포 URL (예: `https://your-domain.com/slack/oauth/callback`)
3. User Token Scopes에 다음 권한 추가:
   - `chat:write` (메시지 삭제를 위해 필요)
   - `im:history` (DM 메시지 접근을 위해 필요)
   - `im:read` (DM 채널 조회를 위해 필요)
   - `channels:history` (채널 메시지 접근을 위해 필요)
   - `groups:history` (비공개 채널 메시지 접근을 위해 필요)
   - `mpim:history` (그룹 DM 메시지 접근을 위해 필요)
   - `mpim:read` (그룹 DM 채널 조회를 위해 필요)
   - `users:read` (사용자 정보 조회를 위해 필요)

4. 앱 설정 페이지 상단의 "Basic Information"에서 클라이언트 ID와 클라이언트 시크릿을 확인

### 3. 환경 변수 설정

프로젝트 루트 디렉토리에 `.env` 파일을 생성하고 다음 내용을 추가합니다:

```env
# 서버 설정
PORT=3000

# Slack 앱 설정
SLACK_CLIENT_ID=your_client_id_here
SLACK_CLIENT_SECRET=your_client_secret_here
SLACK_REDIRECT_URI=http://localhost:3000/slack/oauth/callback

# CORS 설정 (필요한 경우)
ALLOWED_ORIGINS=http://localhost:3000,https://your-domain.com
```

※ 실제 서비스 배포 시에는 PORT, NODE_ENV, SLACK_REDIRECT_URI 값을 적절히
 변경해주세요.

## 실행 방법

### 개발 모드

```bash
# 개발 서버 실행
npm run start:dev
# 또는
yarn start:dev
```

### 프로덕션 모드

```bash
# 빌드
npm run build
# 또는
yarn build

# 프로덕션 서버 실행
npm run start:prod
# 또는
yarn start:prod
```

서버가 실행되면 `http://localhost:3000`(또는 설정한 포트)에서 애플리케이션에 접속할 수 있습니다.

## 사용 방법

1. 웹 브라우저에서 `http://localhost:3000`(또는 설정한 URL) 접속
2. "Slack으로 로그인" 버튼 클릭
3. Slack 인증 화면에서 앱에 대한 권한 승인
4. 로그인 후 메시지 삭제 기능 사용:
   - DM 메시지 삭제
   - 특정 사용자와의 DM 메시지만 삭제
   
[//]: # (   - 특정 채널의 메시지 삭제)
[//]: # (   - 모든 채널에서 자신의 메시지 삭제)

## 주의사항

- 삭제된 메시지는 복구할 수 없으므로 신중하게 사용해주세요.
- Slack API의 레이트 리밋(rate limit)으로 인해 대량의 메시지를 한 번에 삭제할 때 시간이 오래 걸릴 수 있습니다.
- 이 애플리케이션은 개인 목적으로만 사용해야 하며, 다른 사용자의 메시지를 무단으로 삭제하는 것은 Slack 정책에 위반될 수 있습니다.

## 라이선스

MIT License

## 기술 스택

- NestJS (백엔드 프레임워크)
- Express.js (웹 서버)
- @slack/web-api (Slack API 클라이언트)
- OAuth 2.0 (인증)
- TypeScript