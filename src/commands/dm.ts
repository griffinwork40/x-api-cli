import { parseArgs } from 'node:util';
import { XClient } from '../client.js';
import { UsageError } from '../errors.js';
import { safeStringify, collectSecrets } from '../redact.js';
import type { XClientConfig } from '../types.js';

export const DM_HELP = `x dm <send|create-conversation> [flags]   (all writes — user context)
  send                 (--participant <userId> | --conversation <dmConversationId>) [--text <s>] [--media-id <mediaId>]
  create-conversation  --participants <csv> --text <s>`;

export async function runDm(
  client: XClient,
  args: string[],
  cfg: XClientConfig,
): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'send':
      return send(client, rest, cfg);
    case 'create-conversation':
      return createConversation(client, rest, cfg);
    default:
      throw new UsageError(`unknown subcommand '${sub ?? ''}'. ${DM_HELP}`);
  }
}

function print(data: unknown, cfg: XClientConfig): void {
  process.stdout.write(safeStringify(data, collectSecrets(cfg)) + '\n');
}

// ─── send (write) ───────────────────────────────────────────────────────────────

async function send(client: XClient, rest: string[], cfg: XClientConfig): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: {
      participant: { type: 'string' },
      conversation: { type: 'string' },
      text: { type: 'string' },
      'media-id': { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  });

  const participant = values['participant'];
  const conversation = values['conversation'];
  if (participant && conversation) {
    throw new UsageError(
      'provide exactly one of --participant or --conversation, not both. ' + DM_HELP,
    );
  }
  if (!participant && !conversation) {
    throw new UsageError('one of --participant or --conversation is required. ' + DM_HELP);
  }

  const text = values['text'];
  const mediaId = values['media-id'];
  if (!text && !mediaId) {
    throw new UsageError('--text or --media-id is required. ' + DM_HELP);
  }

  const body: Record<string, unknown> = {};
  if (text !== undefined) body['text'] = text;
  if (mediaId !== undefined) body['attachments'] = [{ media_id: mediaId }];

  const path = participant
    ? `/dm_conversations/with/${participant}/messages`
    : `/dm_conversations/${conversation}/messages`;

  const result = await client.post(path, body);
  print(result, cfg);
}

// ─── create-conversation (write) ─────────────────────────────────────────────────

async function createConversation(
  client: XClient,
  rest: string[],
  cfg: XClientConfig,
): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: {
      participants: { type: 'string' },
      text: { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  });

  const participants = values['participants'];
  const text = values['text'];
  if (!participants) throw new UsageError('--participants is required. ' + DM_HELP);
  if (!text) throw new UsageError('--text is required. ' + DM_HELP);

  const participantIds = participants
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (participantIds.length === 0) {
    throw new UsageError('--participants must contain at least one user id. ' + DM_HELP);
  }

  const body: Record<string, unknown> = {
    conversation_type: 'Group',
    participant_ids: participantIds,
    message: { text },
  };

  const result = await client.post('/dm_conversations', body);
  print(result, cfg);
}
