# KIPlay_OX (12:55 OX 서바이벌) — 의존성 0, Node 내장 모듈만. hub 라우트 프록시 뒤(upstream :8080).
FROM node:20-alpine
WORKDIR /app
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
