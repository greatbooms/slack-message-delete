# 명시적으로 x86_64 아키텍처 지정
FROM --platform=linux/amd64 node:18-alpine

WORKDIR /app

# 패키지 파일 복사
COPY package.json yarn.lock ./

# yarn 설치 및 종속성 설치
RUN apk add --no-cache yarn && \
    yarn install --frozen-lockfile

# 소스 코드 복사
COPY . .

# 애플리케이션 빌드
RUN yarn build

# 포트 설정
EXPOSE 3000

# 애플리케이션 실행 (쉘 형식 대신 exec 형식 사용)
CMD ["node", "dist/main.js"]