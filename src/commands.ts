import * as db from './db';
import cache from './cache';
import * as middleware from './middleware';
import { Context } from './interfaces';
import { ISupportee } from './db';
import { closeTicketTopic, deleteTicketTopic, reopenTicketTopic } from './topics';

const resolveTicketFromContext = async (
  ctx: Context,
  includeClosedTopicLookup: boolean = false,
): Promise<ISupportee | null> => {
  let ticket: ISupportee | null = null;

  const replyText = ctx.message.reply_to_message?.text || ctx.message.reply_to_message?.caption;
  const ticketIdFromReply = replyText ? extractTicketId(replyText) : undefined;
  if (ticketIdFromReply) {
    ticket = await db.getByTicketIdAsync(ticketIdFromReply);
  }

  const threadId = (ctx.message as any).message_thread_id;
  if (!ticket && threadId) {
    ticket = includeClosedTopicLookup
      ? await db.getTicketByThreadIdAnyStatus(threadId)
      : await db.getTicketByThreadId(threadId);
  }

  return ticket;
};

/**
 * Extracts ticket ID from the reply text.
 *
 * @param replyText - The text to extract the ticket ID from.
 * @returns The ticket ID as a string or undefined if not found.
 */
const extractTicketId = (replyText: string): string | undefined => {
  const match = replyText.match(
    new RegExp(`\\\\?#T(\\d+)\\s+${cache.config.language.from}`)
  );
  return match ? match[1] : undefined;
};

/**
 * Display help text depending on whether the user is an admin.
 *
 * @param ctx - The bot context.
 */
const helpCommand = (ctx: Context): void => {
  const { language, parse_mode } = cache.config;
  const text = ctx.session.admin ? language.helpCommandStaffText : language.helpCommandText;
  middleware.reply(ctx, text, { parse_mode });
};

/**
 * Send a direct message to a Telegram user by ID.
 *
 * Usage: /direct <telegram_id> <message>
 *
 * @param ctx - The bot context.
 */
const directCommand = async (ctx: Context): Promise<void> => {
  if (!ctx.session.admin) return;

  const rawInput =
    (typeof (ctx as any).match === 'string' && (ctx as any).match.trim()) ||
    (ctx.message?.text || '').replace(/^\/direct(?:@\w+)?\s*/i, '').trim();
  const match = rawInput.match(/^(\d+)\s+([\s\S]+)$/);

  if (!match) {
    middleware.reply(ctx, 'Usage: /direct {telegram_id} {message}');
    return;
  }

  const [, targetUserId, directMessage] = match;

  await middleware.sendMessage(targetUserId, ctx.messenger, directMessage, {});
  middleware.reply(ctx, `${cache.config.language.msg_sent} ${targetUserId}`);
};

/**
 * Close all open tickets.
 *
 * @param ctx - The bot context.
 */
const clearCommand = (ctx: Context): void => {
  if (!ctx.session.admin) return;
  db.closeAll();
  // Reset the ticket arrays
  cache.ticketIDs.length = 0;
  cache.ticketStatus.length = 0;
  cache.ticketSent.length = 0;
  middleware.reply(ctx, 'All tickets closed.');
};

/**
 * Display open tickets.
 *
 * @param ctx - The bot context.
 */
const openCommand = (ctx: Context): void => {
  if (!ctx.session.admin) return;
  const groups: string[] = [];
  const { categories, language } = cache.config;

  if (categories && categories.length > 0) {
    categories.forEach(category => {
      if (!category.subgroups) {
        if (category.group_id == ctx.chat.id) groups.push(category.name);
      } else {
        category.subgroups.forEach((sub: { group_id: any; name: string }) => {
          if (sub.group_id == ctx.chat.id) groups.push(sub.name);
        });
      }
    });
  }

  db.open((userList: any[]) => {
    let openTickets = '';
    userList.forEach(ticket => {
      if (ticket.userid != null) {
        let ticketInfo = '';
        const uidStr = ticket.userid.toString();
        if (uidStr.includes('WEB')) {
          ticketInfo = '(web)';
        } else if (uidStr.includes('SIGNAL')) {
          ticketInfo = '(signal)';
        }
        openTickets += `#T${ticket.id.toString().padStart(6, '0')} ${ticketInfo}\n`;
      }
    });
    middleware.reply(ctx, `*${language.openTickets}\n\n* ${openTickets}`);
  }, groups);
};

/**
 * Close a specific ticket.
 *
 * @param ctx - The bot context.
 */
const closeCommand = async (ctx: Context): Promise<void> => {
  if (!ctx.session.admin) return;
  const ticketToClose = await resolveTicketFromContext(ctx);

  if (!ticketToClose) {
    middleware.reply(ctx, cache.config.language.ticketClosedError);
    return;
  }

  await db.add(
    ticketToClose.userid,
    'closed',
    ticketToClose.category,
    ticketToClose.messenger,
  );
  const paddedTicket = ticketToClose.ticketId.toString().padStart(6, '0');
  middleware.reply(ctx, `${cache.config.language.ticket} #T${paddedTicket} ${cache.config.language.closed}`);
  middleware.sendMessage(
    ticketToClose.userid,
    ticketToClose.messenger,
    `${cache.config.language.ticket} #T${paddedTicket} ${cache.config.language.closed}\n\n${cache.config.language.ticketClosed}`
  );
  await closeTicketTopic(ticketToClose.messageThreadId);

  delete cache.ticketIDs[ticketToClose.userid];
  delete cache.ticketStatus[ticketToClose.userid];
  delete cache.ticketSent[ticketToClose.userid];
};

/**
 * Ban a user based on a ticket.
 *
 * @param ctx - The bot context.
 */
const banCommand = (ctx: Context): void => {
  if (!ctx.session.admin) return;
  const replyText = ctx.message.reply_to_message?.text || ctx.message.reply_to_message?.caption;
  if (!replyText) return;
  const ticketId = extractTicketId(replyText);
  if (!ticketId) return;
  db.getByTicketId(ticketId, (ticket: { userid: any; id: { toString: () => string } }) => {
    if (!ticket) {
      middleware.reply(ctx, cache.config.language.ticketClosedError);
      return;
    }
    db.add(ticket.userid, 'banned', '', ctx.messenger);
    middleware.sendMessage(
      ctx.chat.id,
      ctx.messenger,
      `${cache.config.language.usr_with_ticket} #T${ticketId.toString().padStart(6, '0')} ${cache.config.language.banned}`
    );
  });
};

/**
 * Reopen a closed ticket.
 *
 * @param ctx - The bot context.
 */
const reopenCommand = async (ctx: Context): Promise<void> => {
  if (!ctx.session.admin) return;
  const ticket = await resolveTicketFromContext(ctx, true);
  if (!ticket) {
    middleware.reply(ctx, cache.config.language.ticketClosedError);
    return;
  }

  await db.reopen(ticket.userid, ticket.category || '', ticket.messenger);
  await reopenTicketTopic(ticket.messageThreadId);
  middleware.sendMessage(
    ctx.chat.id,
    ctx.messenger,
    `${cache.config.language.usr_with_ticket} #T${ticket.ticketId.toString().padStart(6, '0')} ${cache.config.language.ticketReopened}`
  );
};

const deleteCommand = async (ctx: Context): Promise<void> => {
  if (!ctx.session.admin) return;
  const ticket = await resolveTicketFromContext(ctx, true);
  if (!ticket) {
    middleware.reply(ctx, cache.config.language.ticketClosedError);
    return;
  }
  if (ticket.status !== 'closed') {
    middleware.reply(ctx, 'Only closed tickets can be deleted.');
    return;
  }

  await deleteTicketTopic(ticket.messageThreadId);
  await db.setMessageThreadId(ticket.ticketId, null);
  middleware.sendMessage(
    ctx.chat.id,
    ctx.messenger,
    `${cache.config.language.ticket} #T${ticket.ticketId.toString().padStart(6, '0')} topic deleted.`,
    { parse_mode: cache.config.parse_mode },
  );
};

/**
 * Unban a user based on a ticket.
 *
 * @param ctx - The bot context.
 */
const unbanCommand = (ctx: Context): void => {
  if (!ctx.session.admin) return;
  const replyText = ctx.message.reply_to_message?.text || ctx.message.reply_to_message?.caption;
  if (!replyText) return;
  const ticketId = extractTicketId(replyText);
  if (!ticketId) return;
  db.getByTicketId(ticketId, (ticket: { userid: any; id: { toString: () => string } }) => {
    if (!ticket) {
      middleware.reply(ctx, cache.config.language.ticketClosedError);
      return;
    }
    db.add(ticket.userid, 'closed', '', ctx.messenger);
    middleware.sendMessage(
      ctx.chat.id,
      ctx.messenger,
      `${cache.config.language.usr_with_ticket} #T${ticket.id.toString().padStart(6, '0')} unbanned`
    );
  });
};

export {
  banCommand,
  openCommand,
  closeCommand,
  unbanCommand,
  clearCommand,
  reopenCommand,
  deleteCommand,
  helpCommand,
  directCommand,
};
