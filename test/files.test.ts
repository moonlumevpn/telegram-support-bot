// Mock dependencies first
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: jest.fn(),
      },
    },
  })),
}));

const mockSendMessage = jest.fn();
const mockReply = jest.fn();
const mockStrictEscape = jest.fn((text) => text);
const mockGetTicketByUserId = jest.fn();
const mockGetTicketByThreadId = jest.fn();
const mockGetTicketByInternalId = jest.fn();
const mockAdd = jest.fn();
const mockAddIdAndName = jest.fn();

jest.mock('../src/middleware', () => ({
  sendMessage: mockSendMessage,
  reply: mockReply,
  strictEscape: mockStrictEscape,
}));

jest.mock('../src/db', () => ({
  getTicketByUserId: mockGetTicketByUserId,
  getTicketByThreadId: mockGetTicketByThreadId,
  getTicketByInternalId: mockGetTicketByInternalId,
  add: mockAdd,
  addIdAndName: mockAddIdAndName,
}));

jest.mock('../src/cache', () => ({
  config: {
    staffchat_id: 'staffchat',
    language: {
      from: 'From:',
      language: 'Language:',
      ticket: 'Ticket',
      file_sent: 'File sent',
      confirmationMessage: 'Confirmation',
      msg_sent: 'Message sent',
      textFirst: 'Text first',
      ticketClosedError: 'Ticket closed',
    },
    spam_time: 60000,
    spam_cant_msg: 5,
    parse_mode: 'MarkdownV2',
    staffchat_parse_mode: 'MarkdownV2',
    autoreply_confirmation: false,
  },
  ticketSent: {},
  userId: '',
}));

import * as files from '../src/files';
import { Context, Messenger } from '../src/interfaces';
import cache from '../src/cache';

describe('Files Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    cache.ticketSent = {};
    cache.userId = '';
    mockGetTicketByUserId.mockResolvedValue(null);
    mockGetTicketByThreadId.mockResolvedValue(null);
    mockGetTicketByInternalId.mockResolvedValue(null);
  });

  const createMockContext = (
    chatType: string = 'private',
    hasFile: boolean = true,
    fileType: string = 'document'
  ): Context => ({
    message: {
      text: fileType === 'document' ? '' : 'File with caption',
      from: {
        id: 'user123',
        first_name: 'John',
        username: 'john_doe',
        is_bot: false,
        language_code: 'en',
      },
      chat: {
        id: 'chat123',
        first_name: 'John',
        username: 'john_doe',
        type: chatType,
      },
      message_id: 1,
      date: 1640995200,
      web_msg: false,
      reply_to_message: {
        from: { is_bot: false },
        text: '',
        caption: '',
      },
      external_reply: { message_id: 0 },
      caption: fileType === 'photo' ? 'Photo caption' : '',
      getFile: jest.fn(),
    },
    messenger: Messenger.TELEGRAM,
    session: {
      lastContactDate: 0,
      admin: false,
      mode: null,
      modeData: {
        ticketid: '1001',
        userid: 'user123',
        name: 'John Doe',
        category: 'support',
      },
      groupCategory: 'support',
      groupTag: 'SUPPORT',
      group: '',
      groupAdmin: null,
      getSessionKey: () => '',
    },
    chat: {
      id: 'chat123',
      first_name: 'John',
      username: 'john_doe',
      type: chatType,
    },
    update_id: 1,
    callbackQuery: { data: '', from: { id: '' }, id: '' },
    from: { username: 'john_doe', id: 'user123' },
    inlineQuery: () => {},
    answerCbQuery: () => {},
    reply: () => {},
    getChat: () => {},
    getFile: () => {},
  });

  describe('forwardFile', () => {
    it('should forward file when user is in private chat', async () => {
      const ctx = createMockContext('private', true, 'document');
      
      await files.forwardFile(ctx);

      // Should call the appropriate database check
      expect(mockGetTicketByUserId).toHaveBeenCalledWith(
        'user123',
        'support'
      );
    });

    it('should not crash for group chats', async () => {
      const ctx = createMockContext('group', true, 'document');
      
      await expect(files.forwardFile(ctx)).resolves.not.toThrow();
    });
  });

  describe('forwardHandler', () => {
    it('should return user info for private chats', () => {
      const ctx = createMockContext('private', true, 'document');
      
      const result = files.forwardHandler(ctx);
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
      expect(result).toContain('John');
      expect(cache.userId).toBe('user123');
    });

    it('should return undefined for non-private chats', () => {
      const ctx = createMockContext('group', true, 'document');
      
      const result = files.forwardHandler(ctx);
      expect(result).toBeUndefined();
    });
  });

  describe('fileHandler', () => {
    it('should keep staff topic replies bound to the topic ticket even if private reply mode is active', async () => {
      const ctx = createMockContext('supergroup', true, 'photo');
      ctx.session.admin = true;
      ctx.session.mode = 'private_reply';
      ctx.session.modeData = {
        ticketid: '1002',
        userid: 'Eternal',
        name: 'Eternal',
        category: 'support',
      };
      ctx.chat.id = 'staffchat';
      ctx.message.chat.id = 'staffchat';
      ctx.message.message_thread_id = 42 as any;
      ctx.message.external_reply = { message_id: 0 };
      ctx.getFile = jest.fn().mockResolvedValue({ file_id: 'photo-file-1' });
      mockGetTicketByThreadId.mockResolvedValue({
        ticketId: 12,
        id: 12,
        userid: 'tatatata',
        status: 'open',
        category: 'support',
        messenger: 'telegram',
        messageThreadId: 42,
      });
      const addon = {
        sendPhoto: jest.fn().mockResolvedValue('9001'),
      };

      await files.fileHandler('photo', addon as any, ctx);

      expect(addon.sendPhoto).toHaveBeenCalledWith(
        'staffchat',
        'photo-file-1',
        expect.objectContaining({
          message_thread_id: 42,
        })
      );
      expect(addon.sendPhoto).not.toHaveBeenCalledWith(
        'Eternal',
        expect.anything(),
        expect.anything()
      );
    });
  });
});
