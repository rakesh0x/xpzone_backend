FROM oven/bun:1

WORKDIR /app

COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile

COPY . .

ENV HOST=0.0.0.0
EXPOSE 4000

CMD ["bun", "run", "index.ts"]
