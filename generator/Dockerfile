FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 1001 mcp && useradd -u 1001 -g mcp -m mcp
WORKDIR /app
COPY package.json ./
COPY node_modules ./node_modules
COPY dist ./dist
USER mcp
ENV NODE_ENV=production
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "dist/mcp-server/index.js"]
