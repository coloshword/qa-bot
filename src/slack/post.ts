import fs from 'node:fs';
import path from 'node:path';
import type { WebClient } from '@slack/web-api';

export class Progress {
  private ts?: string;
  private lines: string[] = [];
  private timer?: NodeJS.Timeout;
  private dirty = false;

  constructor(
    private client: WebClient,
    private channel: string,
    private thread: string,
  ) {}

  step(line: string): void {
    this.lines.push(line);
    this.dirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, 1200);
  }

  private async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    const text = this.lines.slice(-25).join('\n').slice(0, 3500);
    try {
      if (!this.ts) {
        const r = await this.client.chat.postMessage({ channel: this.channel, thread_ts: this.thread, text });
        this.ts = r.ts as string;
      } else {
        await this.client.chat.update({ channel: this.channel, ts: this.ts, text });
      }
    } catch (e) {
      console.error('[progress]', (e as Error).message);
    }
    if (this.dirty) this.schedule();
  }
}

export async function uploadScreenshot(
  client: WebClient,
  channel: string,
  thread: string,
  file: string,
  comment?: string,
): Promise<void> {
  try {
    await client.files.uploadV2({
      channel_id: channel,
      thread_ts: thread,
      filename: path.basename(file),
      file: fs.readFileSync(file),
      initial_comment: comment,
    });
  } catch (e) {
    console.error('[upload]', (e as Error).message);
  }
}

export async function post(client: WebClient, channel: string, thread: string, text: string): Promise<void> {
  try {
    await client.chat.postMessage({ channel, thread_ts: thread, text });
  } catch (e) {
    console.error('[post]', (e as Error).message);
  }
}
