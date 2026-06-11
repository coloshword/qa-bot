import { config } from './config.js';

function adfToText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (n.type === 'text' && typeof n.text === 'string') return n.text;
  const sep = n.type === 'paragraph' || n.type === 'heading' ? '\n' : '';
  const inner = Array.isArray(n.content) ? n.content.map(adfToText).join('') : '';
  return inner + sep;
}

export async function fetchTicketContext(key: string): Promise<string> {
  const { jiraBaseUrl, jiraEmail, jiraApiToken } = config;
  if (!jiraBaseUrl || !jiraEmail || !jiraApiToken) return '';

  try {
    const auth = Buffer.from(`${jiraEmail}:${jiraApiToken}`).toString('base64');
    const url = `${jiraBaseUrl}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,status,issuetype`;
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      console.error(`[ticket] Jira ${key} -> HTTP ${res.status}`);
      return '';
    }

    const data = (await res.json()) as { fields?: Record<string, any> };
    const f = data.fields ?? {};
    const description =
      typeof f.description === 'string' ? f.description : adfToText(f.description).trim();

    return [
      `Summary: ${f.summary ?? ''}`,
      f.issuetype?.name ? `Type: ${f.issuetype.name}` : '',
      f.status?.name ? `Status: ${f.status.name}` : '',
      description ? `\nDescription:\n${description}` : '',
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, 6000);
  } catch (e) {
    console.error('[ticket] Jira lookup failed (non-fatal):', (e as Error).message);
    return '';
  }
}
