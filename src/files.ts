import * as db from './db';
import cache from './cache';
import * as middleware from './middleware';
import { Addon, Context, ModeData, ParseMode } from './interfaces';
import { ISupportee } from './db';
import { buildStaffChatSendOptions, ensureTicketTopicId, isStaffTopicMessage } from './topics';

/**
 * Generates the reply markup for a private reply.
 *
 * @param ctx - The current bot context.
 * @returns The reply markup object.
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
          ? {
            text: language.replyPrivate,
            url: `https://t.me/${from.username}`,
          }
          : {
            text: language.replyPrivate,
            callback_data: `${from.id}---${message.from.first_name}---${modeData.category}---${modeData.ticketid}`,
          },
      ],
    ],
  };
};

/**
 * Handles forwarding of files (document, photo, video) to staff.
 *
 * @param type - The type of file ('document', 'photo', or 'video').
 * @param bot - The bot addon instance.
 * @param ctx - The bot context.
 */
async function fileHandler(type: string, bot: Addon, ctx: Context) {
  const { message, session } = ctx;
  const { config } = cache;
  let userid: string | number | null;
  let replyText = '';
  const inStaffChat =
    ctx.chat?.id?.toString() === config.staffchat_id.toString();
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

  // If replying to a message and if the session is admin, extract ticket info
  if (message && message.reply_to_message && session.admin) {
    replyText = message.reply_to_message.text || message.reply_to_message.caption || '';
    if (replyMessageId && !adminTicket) {
      const ticketByReply = await db.getTicketByInternalId(replyMessageId);
      if (ticketByReply) {
        adminTicket = ticketByReply;
      }
    }
  }

  let userInfo: any;
  let ticket: ISupportee | null = null;
  if (session.admin && adminTicket) {
    userid = adminTicket.userid;
    ticket = adminTicket;
  } else {
    if (!userid) {
      userid = message.from.id;
    }
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
    return;
  }

  let captionText = `${config.language.ticket} #T${ticket.id
    .toString()
    .padStart(6, '0')} ${userInfo}\n${message.caption || ''}`;
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
  let captionForStaff: string;
  if (userInfo !== undefined && !config.anonymous_tickets) {
    // User sending file to staff — build caption with tg:// user link
    const userId = message.from.id;
    const firstName = message.from.first_name;
    const langCode = message.from.language_code;
    const captionRaw = message.caption || '';
    const ticketNum = `#T${ticket.id.toString().padStart(6, '0')}`;
    let nameLink: string;
    if (staffParseMode === ParseMode.HTML) {
      nameLink = `<a href="tg://user?id=${userId}">${middleware.strictEscape(firstName, ParseMode.HTML)}</a> <code>${userId}</code>`;
    } else if (staffParseMode === ParseMode.MarkdownV2 || staffParseMode === ParseMode.Markdown) {
      nameLink = `[${middleware.strictEscape(firstName, staffParseMode)}](tg://user?id=${userId}) \`${userId}\``;
    } else {
      nameLink = `${firstName} (${userId})`;
    }
    const captionEsc = captionRaw ? `\n\n${middleware.strictEscape(captionRaw, staffParseMode)}` : '';
    captionForStaff = `${config.language.ticket} ${ticketNum} ${config.language.from} ${nameLink} ${config.language.language}: ${langCode}${captionEsc}`;
  } else {
    captionForStaff = middleware.strictEscape(captionText, staffParseMode);
  }
  const commonOptions = {
    caption: receiverId === config.staffchat_id ? captionForStaff : captionText,
    reply_markup: isPrivate ? replyMarkup(ctx) : {},
    ...(receiverId === config.staffchat_id ? buildStaffChatSendOptions(staffThreadId) : {}),
  };

  // Send the file based on its type
  var messageId = null;
  switch (type) {
    case 'document':
      messageId = await bot.sendDocument(receiverId, fileId, commonOptions);
      if (
        session.group !== '' &&
        session.group !== config.staffchat_id &&
        JSON.stringify(session.modeData) !== JSON.stringify({})
      ) {
        bot.sendDocument(session.group, fileId, {
          caption: captionText,
          reply_markup: {
            html: '',
            inline_keyboard: [
              [
                {
                  text: config.language.replyPrivate,
                  callback_data: `${ctx.from.id}---${message.from.first_name}---${session.groupCategory}---${ticket.id}`,
                },
              ],
            ],
          },
        });
      } 
      break;
    case 'photo':
      messageId = await bot.sendPhoto(receiverId, fileId, commonOptions);
      if (
        session.group !== '' &&
        session.group !== config.staffchat_id &&
        JSON.stringify(session.modeData) !== JSON.stringify({})
      ) {
        bot.sendPhoto(session.group, fileId, {
          caption: captionText,
          reply_markup: {
            html: '',
            inline_keyboard: [
              [
                {
                  text: config.language.replyPrivate,
                  callback_data: `${ctx.from.id}---${message.from.first_name}---${session.groupCategory}---${ticket.id}`,
                },
              ],
            ],
          },
        });
      }
      break;
    case 'video':
      messageId = await bot.sendVideo(receiverId, fileId, commonOptions);
      if (
        session.group !== '' &&
        session.group !== config.staffchat_id &&
        JSON.stringify(session.modeData) !== JSON.stringify({})
      ) {
        bot.sendVideo(session.group, fileId, {
          caption: captionText,
          reply_markup: {
            html: '',
            inline_keyboard: [
              [
                {
                  text: config.language.replyPrivate,
                  callback_data: `${ctx.from.id}---${message.from.first_name}---${session.groupCategory}---${ticket.id}`,
                },
              ],
            ],
          },
        });
      }
      break;
  }
  db.addIdAndName(ticket.ticketId, messageId, ctx.message.from.first_name);

  // Send confirmation message if enabled
  if (!config.autoreply_confirmation) return;
  let confirmationMessage = `${config.language.confirmationMessage}${config.show_user_ticket
    ? config.language.yourTicketId + ' #T' + ticket.id.toString().padStart(6, '0')
    : ''
    }`;
  if (session.admin && userInfo === undefined) {
    const name = ticket.name || (() => {
      const nameMatch = replyText.match(
        new RegExp(`${config.language.from} (.*) ${config.language.language}`)
      );
      return nameMatch ? nameMatch[1] : null;
    })();
    if (!name) return;
    middleware.reply(ctx, `${config.language.file_sent} ${name}`);
    return;
  }
  middleware.sendMessage(ctx.chat.id, ticket.messenger, confirmationMessage);
};

/**
 * Handles file forwarding with caching and spam protection.
 *
 * @param ctx - The bot context.
 * @param callback - Callback function receiving user information.
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
      setTimeout(() => {
        cache.ticketSent[cache.userId] = undefined;
      }, cache.config.spam_time);
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
};

/**
 * Determines if the message comes from a private chat and returns user info.
 *
 * @param ctx - The bot context.
 * @param callback - Callback function receiving user info (or undefined).
 */
function forwardHandler(ctx: Context) {
  if (ctx.chat.type === 'private') {
    cache.userId = ctx.message.from.id;
    const userInfo = `${cache.config.language.from} ${ctx.message.from.first_name} ${cache.config.language.language}: ${ctx.message.from.language_code}\n\n`;
    return userInfo;
  } else {
    return undefined;
  }
};

export { fileHandler, forwardFile, forwardHandler };
