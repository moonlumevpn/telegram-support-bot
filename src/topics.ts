import cache from './cache';
import * as db from './db';
import TelegramAddon from './addons/telegram';
import { Context } from './interfaces';
import { ISupportee } from './db';
import * as log from 'fancy-log';

const MAX_TOPIC_NAME_LEN = 128;

function buildTopicName(ticket: ISupportee, ctx: Context): string {
  const ticketLabel = `T${ticket.ticketId.toString().padStart(6, '0')}`;
  const userName = (ctx?.message?.from?.first_name || 'User').trim();
  const categoryPart = ticket.category ? ` [${ticket.category}]` : '';
  const topicName = `${ticketLabel} - ${userName}${categoryPart}`;
  return topicName.slice(0, MAX_TOPIC_NAME_LEN);
}

export async function ensureTicketTopicId(
  ticket: ISupportee,
  ctx: Context,
): Promise<number | null> {
  if (cache.config.staffchat_type !== 'telegram') return null;
  if (ticket?.messageThreadId) return ticket.messageThreadId;

  try {
    const topic = await TelegramAddon.getInstance().bot.api.createForumTopic(
      cache.config.staffchat_id.toString(),
      buildTopicName(ticket, ctx),
    );
    const threadId = topic.message_thread_id;
    await db.setMessageThreadId(ticket.ticketId, threadId);
    ticket.messageThreadId = threadId;
    return threadId;
  } catch (err) {
    log.error('Could not create forum topic for ticket', ticket?.ticketId, err);
    return null;
  }
}

export function buildStaffChatSendOptions(messageThreadId: number | null): any {
  const options: any = {
    parse_mode: cache.config.staffchat_parse_mode || cache.config.parse_mode,
  };
  if (messageThreadId) {
    options.message_thread_id = messageThreadId;
  }
  return options;
}

export async function closeTicketTopic(messageThreadId: number | null): Promise<void> {
  if (cache.config.staffchat_type !== 'telegram') return;
  if (!messageThreadId) return;

  try {
    await TelegramAddon.getInstance().bot.api.closeForumTopic(
      cache.config.staffchat_id.toString(),
      messageThreadId,
    );
  } catch (err) {
    log.error('Could not close forum topic', messageThreadId, err);
  }
}

export async function reopenTicketTopic(messageThreadId: number | null): Promise<void> {
  if (cache.config.staffchat_type !== 'telegram') return;
  if (!messageThreadId) return;

  try {
    await TelegramAddon.getInstance().bot.api.reopenForumTopic(
      cache.config.staffchat_id.toString(),
      messageThreadId,
    );
  } catch (err) {
    log.error('Could not reopen forum topic', messageThreadId, err);
  }
}

export async function deleteTicketTopic(messageThreadId: number | null): Promise<void> {
  if (cache.config.staffchat_type !== 'telegram') return;
  if (!messageThreadId) return;

  try {
    await TelegramAddon.getInstance().bot.api.deleteForumTopic(
      cache.config.staffchat_id.toString(),
      messageThreadId,
    );
  } catch (err) {
    log.error('Could not delete forum topic', messageThreadId, err);
  }
}
