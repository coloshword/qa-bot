interface SessionEntry {
  sessionId: string;
  channel: string;
  runDir: string;
  slot: number;
}

const store = new Map<string, SessionEntry>();

export function set(threadTs: string, sessionId: string, channel: string, runDir: string, slot: number): void {
  store.set(threadTs, { sessionId, channel, runDir, slot });
}

export function get(threadTs: string): SessionEntry | undefined {
  return store.get(threadTs);
}
