FROM mcr.microsoft.com/playwright:v1.49.1-jammy

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# System CLIs: gh (GitHub) + acli (Atlassian)
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl gnupg ca-certificates \
  && mkdir -p -m 755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# Global node tooling: Claude Code + Playwright MCP, plus a matching chromium build
RUN npm install -g @anthropic-ai/claude-code @playwright/mcp \
  && npx playwright install chromium

COPY package.json package-lock.json* ./
RUN npm install

COPY . .

RUN npm run typecheck

ENTRYPOINT ["npm", "start"]
