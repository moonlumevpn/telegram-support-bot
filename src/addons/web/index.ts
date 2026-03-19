import fakectx from '../fakectx';
import {ticketHandler} from '../../text';
import cache from '../../cache';
import TelegramAddon from '../telegram';
import { Messenger } from '../../interfaces';
import rateLimit from 'express-rate-limit';
import * as log from 'fancy-log'

/* include script
<script id="chatScript" src="localhost:8080/chat.js"></script>
*/
const init = function(bot: TelegramAddon) {
  // Enable web server with socketio
  if (cache.config.web_server) {
    // Set up rate limiter
    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 100,
      standardHeaders: true,
      legacyHeaders: false,
    });

    const express = require('express');
    const http = require('http');
    const app = express();
    const port = cache.config.web_server_port;
    const server = http.createServer(app);

    const {Server} = require('socket.io');
    const io = new Server(server);
    cache.io = io;
    app.use(limiter);

    // app.get('/', (req, res) => {
    //   res.writeHead(200, {'Content-Type': 'text/html'});
    // });

    app.get('/', (_req: any, res: any) => {
      res.sendFile(__dirname + '/index.html');
    });

    app.get('/chat.js', (_req: any, res: any) => {
      res.sendFile(__dirname + '/chat.js');
    });

    type WebChatPayload = {
      text: string;
      name?: string;
      username?: string;
      metadata?: Record<string, any>;
    };

    const normalizePayload = (payload: unknown): WebChatPayload | null => {
      if (typeof payload === 'string') {
        return {text: payload};
      }
      if (payload && typeof payload === 'object') {
        const text = (payload as any).text;
        if (typeof text === 'string') {
          return {
            text,
            name: (payload as any).name,
            username: (payload as any).username,
            metadata: (payload as any).metadata,
          };
        }
      }
      return null;
    };

    io.on(
        'connection',
        (socket: {
        on: (arg0: string, arg1: any) => void;
        emit: (arg0: string, arg1: any) => void;
        id: string;
      }) => {
          socket.on('chat', (payload: unknown) => {
            const normalized = normalizePayload(payload);
            if (!normalized || !normalized.text) {
              return;
            }
            socket.emit('chat_user', normalized.text);
            fakectx.messenger = Messenger.WEB;
            fakectx.message.from.id = 'WEB' + socket.id;
            fakectx.message.chat.id = 'WEB' + socket.id;
            fakectx.message.text = normalized.text;
            fakectx.from.id = 'WEB' + socket.id;
            if (normalized.name) {
              fakectx.message.from.first_name = normalized.name;
              fakectx.message.chat.first_name = normalized.name;
            }
            if (normalized.username) {
              fakectx.message.from.username = normalized.username;
              fakectx.message.chat.username = normalized.username;
              fakectx.from.username = normalized.username;
            }
            if (normalized.metadata) {
              (fakectx.message as any).metadata = normalized.metadata;
            }
            ticketHandler(bot, fakectx);
          });
          socket.on('disconnect', () => log.info('Disconnected'));
        },
    );

    server.listen(port, () => log.info(`Server started on port ${port}`));
  }
};

export {init};
