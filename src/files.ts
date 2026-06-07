import * as db from './db';
import cache from './cache';
import * as middleware from './middleware';
import { Addon, Context, ModeData, ParseMode } from './interfaces';
import { ISupportee } from './db';
import { buildStaffChatSendOptions, ensureTicketTopicId, isStaffTopicMessage } from './topics';
import TelegramAddon from './addons/telegram';
import * as log from './logger';

const MEDIA_GROUP_DELAY_MS = 500;

interface MediaGroupItem {
  type: string;
  fileId: string;
  caption: string;
}

interface MediaGroupState {
  items: MediaGroupItem[];
  ticket: ISupportee;
  receiverId: string | number;
  captionForStaff: string;
  staffParseMode: string;
  staffThreadId: number | null;
  isAdminToUser: boolean;
  confirmName: string | null;
  ctx: Context;
  timer: ReturnType<typeof setTimeout>;
}

// groupId → resolved state (setup done)
const mediaGroupBuffer = new Map<string, MediaGroupState>();
// groupId → Promise that resolves once the first item finishes setup
const mediaGroupSetup = new Map<string, Promise<MediaGroupState | null>>();

async function flushMediaGroup(groupId: string): Promise<void> {
  const state = mediaGroupBuffer.get(groupId);
  mediaGroupBuffer.delete(groupId);
  if (!state) return;

  const {
    items, ticket, receiverId, captionForStaff, staffParseMode,
    staffThreadId, isAdminToUser, confirmName, ctx,
  } = state;
  const { config } = cache;

  const mediaArray = items.map((item, i) => {
    const entry: any = { type: item.type, media: item.fileId };
    if (i === 0) {
      if (isAdminToUser) {
        if (item.caption) entry.caption = item.caption;
      } else {
        entry.caption = captionForStaff;
        entry.parse_mode = staffParseMode;
      }
    }
    return entry;
  });

  try {
    const extraOpts: any = {};
    if (staffThreadId) extraOpts.message_thread_id = staffThreadId;
    const msgs = await TelegramAddon.getInstance().bot.api.sendMediaGroup(
      receiverId.toString(),
      mediaArray,
      extraOpts,
    );
    if (msgs?.[0]) {
      db.addIdAndName(ticket.ticketId, msgs[0].message_id.toString(), ctx.message.from.first_name);
    }
  } catch (e) {
    log.error('sendMediaGroup failed:', e);
  }

  if (!config.autoreply_confirmation) return;
  if (isAdminToUser) {
    if (!confirmName) return;
    middleware.reply(ctx, `${config.language.file_sent} ${confirmName}`);
  } else {
    const confirmMsg = `${config.language.confirmationMessage}${config.show_user_ticket
      ? config.language.yourTicketId + ' #T' + ticket.id.toString().padStart(6, '0')
      : ''}`;
    middleware.sendMessage(ctx.chat.id, ticket.messenger, confirmMsg);
  }
}

/**
 * Generates the reply markup for a private reply.
 */
const replyMarkup = (ctx: Context): object => {
  const { config } = cache;
  const { language, direct_reply } = config;
  const { from, message, session } = ctx;
  const { modeData } = session;
  return {
    html: '',
    inline_keyboard: [
      [
        direct_reply
          ? { text: language.replyPrivate, url: `https://t.me/${from.username}` }
          : {
            text: language.replyPrivate,
            callback_data: `${from.id}---${message.from.first_name}---${modeData.category}---${modeData.ticketid}`,
          },
      ],
    ],
  };
};

/**
 * Build the name+ID string for staff captions/messages.
 */
function buildNameLink(
  userId: string,
  firstName: string,
  parseMode: string,
): string {
  if (parseMode === ParseMode.HTML) {
    return `<a href="tg://user?id=${userId}">${middleware.strictEscape(firstName, ParseMode.HTML)}</a> <code>${userId}</code>`;
  }
  if (parseMode === ParseMode.MarkdownV2 || parseMode === ParseMode.Markdown) {
    return `[${middleware.strictEscape(firstName, parseMode)}](tg://user?id=${userId}) \`${userId}\``;
  }
  return `${firstName} (${userId})`;
}

/**
 * Handles forwarding of files (document, photo, video) to staff.
 */
async function fileHandler(type: string, bot: Addon, ctx: Context) {
  const { message, session } = ctx;
  const { config } = cache;
  const mediaGroupId = (message as any)?.media_group_id as string | undefined;

  // ── Media group: buffer already ready ─────────────────────────────────────
  if (mediaGroupId && mediaGroupBuffer.has(mediaGroupId)) {
    const fileId = (await ctx.getFile()).file_id;
    const state = mediaGroupBuffer.get(mediaGroupId)!;
    clearTimeout(state.timer);
    state.items.push({ type, fileId, caption: message.caption || '' });
    state.timer = setTimeout(() => flushMediaGroup(mediaGroupId), MEDIA_GROUP_DELAY_MS);
    return;
  }

  // ── Media group: first item still setting up — wait, then append ──────────
  if (mediaGroupId && mediaGroupSetup.has(mediaGroupId)) {
    const [fileId] = await Promise.all([
      ctx.getFile().then((f: any) => f.file_id),
      mediaGroupSetup.get(mediaGroupId)!,
    ]);
    const currentState = mediaGroupBuffer.get(mediaGroupId);
    if (currentState && fileId) {
      clearTimeout(currentState.timer);
      currentState.items.push({ type, fileId, caption: message.caption || '' });
      currentState.timer = setTimeout(() => flushMediaGroup(mediaGroupId), MEDIA_GROUP_DELAY_MS);
    }
    return;
  }

  // ── First item (or single file): reserve slot SYNCHRONOUSLY before any await
  let resolveSetup: ((s: MediaGroupState | null) => void) | undefined;
  if (mediaGroupId) {
    mediaGroupSetup.set(
      mediaGroupId,
      new Promise<MediaGroupState | null>(resolve => { resolveSetup = resolve; }),
    );
  }

  // Resolves the setup promise and cleans up the setup map.
  const finishSetup = (state: MediaGroupState | null) => {
    if (resolveSetup) {
      resolveSetup(state);
      mediaGroupSetup.delete(mediaGroupId!);
    }
  };

  let userid: string | number | null;
  let replyText = '';
  const inStaffChat = ctx.chat?.id?.toString() === config.staffchat_id.toString();
  const threadId = (message as any)?.message_thread_id;
  const replyMessageId = message?.external_reply?.message_id;
  let adminTicket: ISupportee | null = null;

  // If admin is replying in staff chat, resolve ticket by topic or replied message.
  if (session.admin) {
    if (threadId && inStaffChat) {
      adminTicket = await db.getTicketByThreadId(threadId);
    }
    if (!adminTicket && replyMessageId) {
      adminTicket = await db.getTicketByInternalId(replyMessageId);
    }
  }

  if (message && message.reply_to_message && session.admin) {
    replyText = message.reply_to_message.text || message.reply_to_message.caption || '';
    if (replyMessageId && !adminTicket) {
      const ticketByReply = await db.getTicketByInternalId(replyMessageId);
      if (ticketByReply) adminTicket = ticketByReply;
    }
  }

  let userInfo: any;
  let ticket: ISupportee | null = null;
  if (session.admin && adminTicket) {
    userid = adminTicket.userid;
    ticket = adminTicket;
  } else {
    if (!userid) userid = message.from.id;
    userInfo = await forwardFile(ctx);
    ticket = await db.getTicketByUserId(userid, session.groupCategory);
  }

  let receiverId: string | number = config.staffchat_id;
  let isPrivate = false;

  if (!ticket) {
    if (session.admin && userInfo === undefined) {
      middleware.reply(ctx, config.language.ticketClosedError);
    } else {
      middleware.reply(ctx, config.language.textFirst);
    }
    finishSetup(null);
    return;
  }

  let captionText = `${config.language.ticket} #T${ticket.id.toString().padStart(6, '0')} ${userInfo}\n${message.caption || ''}`;
  if (session.admin && userInfo === undefined) {
    receiverId = ticket.userid;
    captionText = message.caption || '';
  }
  if (session.modeData?.userid != null && !isStaffTopicMessage(ctx)) {
    receiverId = session.modeData.userid;
    isPrivate = true;
  }

  const fileId = (await ctx.getFile()).file_id;
  const staffThreadId =
    receiverId === config.staffchat_id ? await ensureTicketTopicId(ticket, ctx) : null;
  const staffParseMode = config.staffchat_parse_mode || config.parse_mode;

  // Build staff caption with tg:// user link (only when not anonymous).
  let captionForStaff: string;
  if (userInfo !== undefined && !config.anonymous_tickets) {
    const userId = message.from.id;
    const firstName = message.from.first_name;
    const langCode = message.from.language_code;
    const captionRaw = message.caption || '';
    const ticketNum = `#T${ticket.id.toString().padStart(6, '0')}`;
    const nameLink = buildNameLink(userId, firstName, staffParseMode);
    const captionEsc = captionRaw ? `\n\n${middleware.strictEscape(captionRaw, staffParseMode)}` : '';
    captionForStaff = `${config.language.ticket} ${ticketNum} ${config.language.from} ${nameLink} ${config.language.language}: ${langCode}${captionEsc}`;
  } else {
    captionForStaff = middleware.strictEscape(captionText, staffParseMode);
  }

  // ── Media group: buffer the first item and wait for siblings ──────────────
  if (mediaGroupId) {
    const confirmName = (session.admin && userInfo === undefined)
      ? (ticket.name || (() => {
          const m = replyText.match(new RegExp(`${config.language.from} (.*) ${config.language.language}`));
          return m ? m[1] : null;
        })())
      : null;

    const state: MediaGroupState = {
      items: [{ type, fileId, caption: message.caption || '' }],
      ticket,
      receiverId,
      captionForStaff,
      staffParseMode,
      staffThreadId,
      isAdminToUser: !!(session.admin && userInfo === undefined),
      confirmName,
      ctx,
      timer: setTimeout(() => flushMediaGroup(mediaGroupId), MEDIA_GROUP_DELAY_MS),
    };
    mediaGroupBuffer.set(mediaGroupId, state);
    finishSetup(state);
    return;
  }

  // ── Single file ────────────────────────────────────────────────────────────
  const commonOptions = {
    caption: receiverId === config.staffchat_id ? captionForStaff : captionText,
    reply_markup: isPrivate ? replyMarkup(ctx) : {},
    ...(receiverId === config.staffchat_id ? buildStaffChatSendOptions(staffThreadId) : {}),
  };

  var messageId = null;
  switch (type) {
    case 'document':
      messageId = await bot.sendDocument(receiverId, fileId, commonOptions);
      if (session.group !== '' && session.group !== config.staffchat_id && JSON.stringify(session.modeData) !== JSON.stringify({})) {
        bot.sendDocument(session.group, fileId, {
          caption: captionText,
          reply_markup: { html: '', inline_keyboard: [[{ text: config.language.replyPrivate, callback_data: `${ctx.from.id}---${message.from.first_name}---${session.groupCategory}---${ticket.id}` }]] },
        });
      }
      break;
    case 'photo':
      messageId = await bot.sendPhoto(receiverId, fileId, commonOptions);
      if (session.group !== '' && session.group !== config.staffchat_id && JSON.stringify(session.modeData) !== JSON.stringify({})) {
        bot.sendPhoto(session.group, fileId, {
          caption: captionText,
          reply_markup: { html: '', inline_keyboard: [[{ text: config.language.replyPrivate, callback_data: `${ctx.from.id}---${message.from.first_name}---${session.groupCategory}---${ticket.id}` }]] },
        });
      }
      break;
    case 'video':
      messageId = await bot.sendVideo(receiverId, fileId, commonOptions);
      if (session.group !== '' && session.group !== config.staffchat_id && JSON.stringify(session.modeData) !== JSON.stringify({})) {
        bot.sendVideo(session.group, fileId, {
          caption: captionText,
          reply_markup: { html: '', inline_keyboard: [[{ text: config.language.replyPrivate, callback_data: `${ctx.from.id}---${message.from.first_name}---${session.groupCategory}---${ticket.id}` }]] },
        });
      }
      break;
  }
  db.addIdAndName(ticket.ticketId, messageId, ctx.message.from.first_name);

  if (!config.autoreply_confirmation) return;
  let confirmationMessage = `${config.language.confirmationMessage}${config.show_user_ticket
    ? config.language.yourTicketId + ' #T' + ticket.id.toString().padStart(6, '0') : ''}`;
  if (session.admin && userInfo === undefined) {
    const name = ticket.name || (() => {
      const nameMatch = replyText.match(new RegExp(`${config.language.from} (.*) ${config.language.language}`));
      return nameMatch ? nameMatch[1] : null;
    })();
    if (!name) return;
    middleware.reply(ctx, `${config.language.file_sent} ${name}`);
    return;
  }
  middleware.sendMessage(ctx.chat.id, ticket.messenger, confirmationMessage);
}

/**
 * Handles file forwarding with caching and spam protection.
 */
async function forwardFile(ctx: Context) {
  const ticket = await db.getTicketByUserId(ctx.message.from.id, ctx.session.groupCategory);
  let ok = false;
  if (!ticket || !ticket.status || ticket.status === 'closed') {
    await db.add(ctx.message.from.id, 'open', ctx.session.groupCategory, ctx.messenger);
    ok = true;
  }
  if (ok || (ticket && ticket.status !== 'banned')) {
    if (cache.ticketSent[cache.userId] === undefined) {
      setTimeout(() => { cache.ticketSent[cache.userId] = undefined; }, cache.config.spam_time);
      cache.ticketSent[cache.userId] = 0;
      return forwardHandler(ctx);
    } else if (cache.ticketSent[cache.userId] < cache.config.spam_cant_msg) {
      cache.ticketSent[cache.userId]++;
      return forwardHandler(ctx);
    } else if (cache.ticketSent[cache.userId] === cache.config.spam_cant_msg) {
      cache.ticketSent[cache.userId]++;
      middleware.sendMessage(ctx.chat.id, ticket.messenger, cache.config.language.blockedSpam, {});
    }
  }
}

/**
 * Determines if the message comes from a private chat and returns user info.
 */
function forwardHandler(ctx: Context) {
  if (ctx.chat.type === 'private') {
    cache.userId = ctx.message.from.id;
    const userInfo = `${cache.config.language.from} ${ctx.message.from.first_name} ${cache.config.language.language}: ${ctx.message.from.language_code}\n\n`;
    return userInfo;
  } else {
    return undefined;
  }
}

export { fileHandler, forwardFile, forwardHandler };
