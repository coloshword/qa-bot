interface SessionEntry {
  sessionId: string;
  channel: string;
}

const store = new Map<string, SessionEntry>();

export function set(threadTs: string, sessionId: string, channel: string): void {
  store.set(threadTs, { sessionId, channel });
}

export function get(threadTs: string): SessionEntry | undefined {
  return store.get(threadTs);
}
