import { App } from '@slack/bolt';
import { config } from './config.js';
import { enqueue, interrupt } from './queue/worker.js';
import * as sessionStore from './session-store.js';

const app = new App({
  token: config.slackBotToken,
  appToken: config.slackAppToken,
  socketMode: true,
});

const PR_RE = /https?:\/\/github\.com\/[^/\s|>]+\/[^/\s|>]+\/pull\/\d+/i;
const TICKET_RE = /[A-Z][A-Z0-9]+-\d+/;
const URL_RE = /https?:\/\/[^\s|>]+/;
const EPHEMERAL_RE = /\bephemeral:\s*(qa-[a-z0-9-]{1,22})/i;

app.event('app_mention', async ({ event, client }) => {
  const text = event.text ?? '';
  const prUrl = text.match(PR_RE)?.[0]?.replace(/[>|]+$/, '');
  const ticket = text.match(TICKET_RE)?.[0];
  let url = text.match(URL_RE)?.[0]?.replace(/[>|]+$/, '');
  if (url && url === prUrl) url = undefined;

  const ephemeralName = text.match(EPHEMERAL_RE)?.[1];
  if (ephemeralName) url = `https://${ephemeralName}.bookofthemoment.com`;

  const instructions = text
    .replace(/<@[^>]+>/g, '')
    .replace(PR_RE, '')
    .replace(TICKET_RE, '')
    .replace(URL_RE, '')
    .replace(EPHEMERAL_RE, '')
    .trim();

  const thread = event.thread_ts ?? event.ts;
  const requester = event.user;

  // Follow-up in a known thread (no PR link needed)
  const existingSession = event.thread_ts ? sessionStore.get(event.thread_ts) : undefined;
  if (existingSession && !prUrl && !ticket && !url) {
    const interrupted = interrupt(thread, instructions, client, event.channel, requester);
    if (!interrupted) {
      enqueue({
        instructions,
        channel: event.channel,
        thread,
        requester,
        client,
        isResume: true,
        resumeSessionId: existingSession.sessionId,
        requiredSlot: existingSession.slot,
      });
    }
    return;
  }

  if (!prUrl && !ticket && !url) {
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: thread,
      text: 'give me a GitHub PR link to QA (e.g. `https://github.com/bookofthemonthclub/Xavier/pull/12345`).',
    });
    return;
  }

  await client.chat.postMessage({
    channel: event.channel,
    thread_ts: thread,
    text: `:eyes: on it${prUrl ? '' : ' — no PR link, working from hints'}`,
  });

  enqueue({ prUrl, ticket, url, instructions, channel: event.channel, thread, requester, client });
});

await app.start();
console.log('qa-bot connected to Slack (Socket Mode)');
