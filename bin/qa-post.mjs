#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { WebClient } from '@slack/web-api';

const token = process.env.SLACK_BOT_TOKEN;
const channel = process.env.QA_SLACK_CHANNEL;
const thread = process.env.QA_SLACK_THREAD;
const requester = process.env.QA_SLACK_REQUESTER;

if (!token || !channel || !thread) {
  console.error('qa-post: missing SLACK_BOT_TOKEN / QA_SLACK_CHANNEL / QA_SLACK_THREAD');
  process.exit(1);
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const positional = argv.slice(1).filter((a) => a !== '--mention');
const mention = argv.includes('--mention') && requester ? `<@${requester}> ` : '';

const client = new WebClient(token);

try {
  if (cmd === 'msg') {
    const text = positional[0];
    if (!text) throw new Error('usage: qa-post msg [--mention] "<text>"');
    await client.chat.postMessage({ channel, thread_ts: thread, text: mention + text });
  } else if (cmd === 'img' || cmd === 'file') {
    const filePath = positional[0];
    const label = positional[1] ?? '';
    if (!filePath) throw new Error(`usage: qa-post ${cmd} [--mention] <path> "<caption|title>"`);
    const opts = {
      channel_id: channel,
      thread_ts: thread,
      file: fs.readFileSync(filePath),
      filename: path.basename(filePath),
    };
    if (cmd === 'img') {
      opts.initial_comment = mention + label;
    } else {
      opts.title = label || path.basename(filePath);
      if (mention) opts.initial_comment = mention.trim();
    }
    await client.files.uploadV2(opts);
  } else {
    throw new Error('usage: qa-post msg|img|file ...');
  }
  console.log('qa-post: ok');
} catch (e) {
  console.error('qa-post error:', e.message);
  process.exit(1);
}
