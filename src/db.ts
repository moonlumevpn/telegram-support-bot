import mongoose from 'mongoose';
import cache from './cache';
import { Messenger } from './interfaces';
import * as log from 'fancy-log'

const STORAGE_DRIVER = (cache.config.storage_driver || 'mongo').toLowerCase();
const SQLITE_PATH = cache.config.sqlite_path || './config/support.db';
const MONGO_URI = cache.config.mongodb_uri || process.env.MONGO_URI || 'mongodb://localhost:27017/support';
const botTokenSuffix = cache.config.bot_token.slice(-5);
const collectionName = `bot_${cache.config.owner_id}_${botTokenSuffix}`;

export interface ISupportee extends mongoose.Document {
  ticketId: number;
  userid: string;
  internalIds: Array<number> | null;
  name: string | null;
  messageThreadId: number | null;
  messenger: Messenger;
  status: string;
  category: string | null;
}

export const SupporteeSchema = new mongoose.Schema<ISupportee>({
  ticketId: { type: Number, required: true, unique: true, alias: 'id' },
  userid: { type: String, required: true },
  internalIds: { type: [Number], required: false },
  name: { type: String, required: false },
  messageThreadId: { type: Number, required: false, default: null },
  messenger: { type: String, required: true },
  status: { type: String, default: 'open' },
  category: { type: String, default: null },
});

const Supportee = mongoose.model(collectionName, SupporteeSchema);
let sqliteDb: any = null;

const ensureSqlite = () => {
  if (!sqliteDb) {
    throw new Error('SQLite database not initialized. Did you call connect()?');
  }
};

const parseInternalIds = (value: any): number[] | null => {
  if (!value) return null;
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
};

const rowToSupportee = (row: any): ISupportee => {
  return {
    ticketId: row.ticketId,
    userid: row.userid,
    internalIds: parseInternalIds(row.internalIds),
    name: row.name ?? null,
    messageThreadId: row.messageThreadId ?? null,
    messenger: row.messenger,
    status: row.status,
    category: row.category ?? null,
  } as ISupportee;
};

const toTicketIdQueryValue = (value: any): number => {
  const num = typeof value === 'number' ? value : parseInt(String(value), 10);
  return Number.isNaN(num) ? -1 : num;
};

export async function connect() {
  if (STORAGE_DRIVER === 'sqlite') {
    try {
      // Dynamically require better-sqlite3 to avoid native build errors when unused
      const Database = require('better-sqlite3');
      sqliteDb = new Database(SQLITE_PATH);
      sqliteDb.pragma('journal_mode = WAL');
      sqliteDb.pragma('foreign_keys = ON');
      sqliteDb.pragma('busy_timeout = 5000');
      sqliteDb.exec(`
        CREATE TABLE IF NOT EXISTS supportees (
          ticketId INTEGER PRIMARY KEY,
          userid TEXT NOT NULL,
          internalIds TEXT,
          name TEXT,
          messageThreadId INTEGER,
          messenger TEXT NOT NULL,
          status TEXT NOT NULL,
          category TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_supportees_userid ON supportees(userid);
        CREATE INDEX IF NOT EXISTS idx_supportees_status ON supportees(status);
        CREATE INDEX IF NOT EXISTS idx_supportees_messenger ON supportees(messenger);
        CREATE INDEX IF NOT EXISTS idx_supportees_thread ON supportees(messageThreadId);
        CREATE INDEX IF NOT EXISTS idx_supportees_category ON supportees(category);
      `);
      log.info(`Connected to sqlite database at ${SQLITE_PATH}`);
      return sqliteDb;
    } catch (err) {
      log.error('Could not initialize sqlite database. Is better-sqlite3 installed?', err);
      process.exit(1);
    }
  }

  mongoose.connection.on('open', () => {
    log.info('Connected to mongo server.');
  });

  mongoose.connection.on('error', (err) => {
    log.info('Could not connect to mongo server!', err);
    process.exit(1);
  });

  const connection = await mongoose.connect(MONGO_URI, {
    serverSelectionTimeoutMS: 5000,
  });

  return connection;
}

/** Methods **/

export const getNextTicketId = async () => {
  if (STORAGE_DRIVER === 'sqlite') {
    ensureSqlite();
    const row = sqliteDb.prepare('SELECT MAX(ticketId) as maxId FROM supportees').get();
    return row?.maxId ? row.maxId + 1 : 1;
  }
  const lastEntry = await Supportee.findOne()
    .sort({ ticketId: -1 })
    .select('ticketId');
  return lastEntry ? lastEntry.ticketId + 1 : 1; // Start from 1 if no entries
};

export const check = async (
  userid: any,
  category: any,
  callback: (result: any) => void
) => {
  if (STORAGE_DRIVER === 'sqlite') {
    ensureSqlite();
    const ticketIdValue = toTicketIdQueryValue(userid);
    let sql = 'SELECT * FROM supportees WHERE (userid = ? OR ticketId = ?)';
    const params: any[] = [String(userid), ticketIdValue];
    if (category) {
      sql += ' AND category = ?';
      params.push(String(category));
    }
    const rows = sqliteDb.prepare(sql).all(...params);
    callback(rows.map(rowToSupportee));
    return;
  }
  const query = {
    $or: [{ userid: userid }, { ticketId: userid }],
    ...(category && { category }),
  };
  const result = await Supportee.find(query);
  callback(result);
};

export async function getTicketById(
  ticketId: string | number,
  category: string | null
): Promise<ISupportee | null> {
  if (STORAGE_DRIVER === 'sqlite') {
    ensureSqlite();
    const ticketIdValue = toTicketIdQueryValue(ticketId);
    if (category) {
      const row = sqliteDb
        .prepare('SELECT * FROM supportees WHERE ticketId = ? AND category = ? LIMIT 1')
        .get(ticketIdValue, String(category));
      return row ? rowToSupportee(row) : null;
    }
    const row = sqliteDb
      .prepare('SELECT * FROM supportees WHERE ticketId = ? AND category IS NULL LIMIT 1')
      .get(ticketIdValue);
    return row ? rowToSupportee(row) : null;
  }
  const query = {
    $or: [{ ticketId: ticketId }],
    ...(category ? { category } : { category: null }),
  };
  const result = await Supportee.findOne(query);
  return result as ISupportee | null;
};

export async function getTicketByInternalId (
  internalId: number
): Promise<ISupportee | null> {
  if (STORAGE_DRIVER === 'sqlite') {
    ensureSqlite();
    const rows = sqliteDb.prepare('SELECT * FROM supportees WHERE internalIds IS NOT NULL').all();
    for (const row of rows) {
      const internalIds = parseInternalIds(row.internalIds) || [];
      if (internalIds.includes(internalId)) {
        return rowToSupportee(row);
      }
    }
    return null;
  }
  const query = {
    internalIds: { $elemMatch: { $eq: internalId } },
  };
  const result = await Supportee.findOne(query);
  return result as ISupportee | null;
}

export async function getTicketByUserId (
  userId: string | number,
  category: string | null
) {
  if (STORAGE_DRIVER === 'sqlite') {
    ensureSqlite();
    const userIdValue = String(userId);
    if (category) {
      const row = sqliteDb.prepare(
        'SELECT * FROM supportees WHERE userid = ? AND status = ? AND category = ? ORDER BY ticketId DESC LIMIT 1'
      ).get(userIdValue, 'open', String(category));
      if (row) return rowToSupportee(row);
    } else {
      const row = sqliteDb.prepare(
        'SELECT * FROM supportees WHERE userid = ? AND status = ? ORDER BY ticketId DESC LIMIT 1'
      ).get(userIdValue, 'open');
      if (row) return rowToSupportee(row);
    }

    if (category) {
      const row = sqliteDb.prepare(
        'SELECT * FROM supportees WHERE userid = ? AND category = ? ORDER BY ticketId DESC LIMIT 1'
      ).get(userIdValue, String(category));
      return row ? rowToSupportee(row) : null;
    }
    const row = sqliteDb.prepare(
      'SELECT * FROM supportees WHERE userid = ? ORDER BY ticketId DESC LIMIT 1'
    ).get(userIdValue);
    return row ? rowToSupportee(row) : null;
  }
  // Prefer an open ticket for this user, independent of category when category is not provided.
  // This avoids creating a new ticket for every message when session category is not set.
  const openQuery = {
    userid: userId,
    status: 'open',
    ...(category ? { category } : {}),
  };
  let result = await Supportee.findOne(openQuery).sort({ ticketId: -1 });
  if (result) return result;

  const fallbackQuery = {
    userid: userId,
    ...(category ? { category } : {}),
  };
  result = await Supportee.findOne(fallbackQuery).sort({ ticketId: -1 });
  return result;
};

export async function getTicketByThreadId(
  messageThreadId: number,
): Promise<ISupportee | null> {
  if (STORAGE_DRIVER === 'sqlite') {
    ensureSqlite();
    const row = sqliteDb.prepare(
      'SELECT * FROM supportees WHERE messageThreadId = ? AND status = ? LIMIT 1'
    ).get(messageThreadId, 'open');
    return row ? rowToSupportee(row) : null;
  }
  const result = await Supportee.findOne({
    messageThreadId,
    status: 'open',
  });
  return result as ISupportee | null;
}

export async function getTicketByThreadIdAnyStatus(
  messageThreadId: number,
): Promise<ISupportee | null> {
  if (STORAGE_DRIVER === 'sqlite') {
    ensureSqlite();
    const row = sqliteDb.prepare(
      'SELECT * FROM supportees WHERE messageThreadId = ? LIMIT 1'
    ).get(messageThreadId);
    return row ? rowToSupportee(row) : null;
  }
  const result = await Supportee.findOne({ messageThreadId });
  return result as ISupportee | null;
}

export async function getByTicketIdAsync(
  ticketId: string | number,
): Promise<ISupportee | null> {
  if (STORAGE_DRIVER === 'sqlite') {
    ensureSqlite();
    const ticketIdValue = toTicketIdQueryValue(ticketId);
    const row = sqliteDb.prepare(
      'SELECT * FROM supportees WHERE ticketId = ? LIMIT 1'
    ).get(ticketIdValue);
    return row ? rowToSupportee(row) : null;
  }
  const result = await Supportee.findOne({ ticketId });
  return result as ISupportee | null;
}

export const getByTicketId = async (
  ticketId: string,
  callback: (ticket: any) => void
) => {
  if (STORAGE_DRIVER === 'sqlite') {
    ensureSqlite();
    const ticketIdValue = toTicketIdQueryValue(ticketId);
    const row = sqliteDb.prepare(
      'SELECT * FROM supportees WHERE ticketId = ? LIMIT 1'
    ).get(ticketIdValue);
    callback(row ? rowToSupportee(row) : null);
    return;
  }
  const query = { $or: [{ ticketId: ticketId }] };
  const result = await Supportee.findOne(query);
  callback(result);
};

export const checkBan = async (
  userid: any,
  messenger: string,
  callback: (ticket: any) => void
) => {
  if (STORAGE_DRIVER === 'sqlite') {
    ensureSqlite();
    const row = sqliteDb.prepare(
      'SELECT * FROM supportees WHERE messenger = ? AND userid = ? AND status = ? LIMIT 1'
    ).get(String(messenger), String(userid), 'banned');
    callback(row ? rowToSupportee(row) : null);
    return;
  }
  const query = {
    messenger,
    $or: [{ userid: userid }],
    status: 'banned',
  };
  const result = await Supportee.findOne(query);
  callback(result);
};

export const closeAll = async () => {
  if (STORAGE_DRIVER === 'sqlite') {
    ensureSqlite();
    sqliteDb.prepare('UPDATE supportees SET status = ?').run('closed');
    return;
  }
  await Supportee.updateMany({}, { $set: { status: 'closed' } });
};

export const reopen = async (userid: any, category: string, messenger: string) => {
  if (STORAGE_DRIVER === 'sqlite') {
    ensureSqlite();
    const ticketIdValue = toTicketIdQueryValue(userid);
    let sql = 'UPDATE supportees SET status = ? WHERE messenger = ? AND (userid = ? OR ticketId = ?)';
    const params: any[] = ['open', String(messenger), String(userid), ticketIdValue];
    if (category) {
      sql += ' AND category = ?';
      params.push(String(category));
    }
    sqliteDb.prepare(sql).run(...params);
    return;
  }
  const query = {
    messenger,
    $or: [{ userid: userid }, { ticketId: userid }],
    ...(category && { category }),
  };
  await Supportee.updateMany(query, { $set: { status: 'open' } });
};

export const addIdAndName = async (
  ticketId: string | number,
  internalId: string,
  name: string | null,
) => {
  if (!internalId) {
    return null;
  }
  if (STORAGE_DRIVER === 'sqlite') {
    ensureSqlite();
    const ticketIdValue = toTicketIdQueryValue(ticketId);
    const row = sqliteDb.prepare('SELECT * FROM supportees WHERE ticketId = ? LIMIT 1')
      .get(ticketIdValue);
    if (!row) {
      return null;
    }
    const currentInternalIds = parseInternalIds(row.internalIds) || [];
    const internalIdNum = parseInt(internalId, 10);
    if (!currentInternalIds.includes(internalIdNum)) {
      currentInternalIds.push(internalIdNum);
    }
    sqliteDb.prepare(
      'UPDATE supportees SET internalIds = ?, name = ? WHERE ticketId = ?'
    ).run(JSON.stringify(currentInternalIds), name, ticketIdValue);
    const updated = sqliteDb.prepare('SELECT * FROM supportees WHERE ticketId = ? LIMIT 1')
      .get(ticketIdValue);
    return updated ? rowToSupportee(updated) : null;
  }
  const internalIdNum = parseInt(internalId);
  const query = {
    ticketId: ticketId,
  };
  const update = {
    $addToSet: { internalIds: internalIdNum },
    $set: { name },
  };
  return await Supportee.findOneAndUpdate(query, update, {
    new: true,
    upsert: true,
  });
};

export const setMessageThreadId = async (
  ticketId: string | number,
  messageThreadId: number | null,
) => {
  if (STORAGE_DRIVER === 'sqlite') {
    ensureSqlite();
    const ticketIdValue = toTicketIdQueryValue(ticketId);
    sqliteDb.prepare(
      'UPDATE supportees SET messageThreadId = ? WHERE ticketId = ?'
    ).run(messageThreadId, ticketIdValue);
    const updated = sqliteDb.prepare('SELECT * FROM supportees WHERE ticketId = ? LIMIT 1')
      .get(ticketIdValue);
    return updated ? rowToSupportee(updated) : null;
  }
  return await Supportee.findOneAndUpdate(
    { ticketId },
    { $set: { messageThreadId } },
    { new: true },
  );
};

export const add = async (
  userid: string | number,
  status: string,
  category: string | number | null,
  messenger: string
) => {
  if (STORAGE_DRIVER === 'sqlite') {
    ensureSqlite();
    const userIdValue = String(userid);
    const categoryValue = category === null || category === undefined ? null : String(category);
    if (status === 'closed') {
      const ticketIdValue = toTicketIdQueryValue(userid);
      let sql = 'UPDATE supportees SET status = ? WHERE messenger = ? AND (userid = ? OR ticketId = ?)';
      const params: any[] = ['closed', String(messenger), userIdValue, ticketIdValue];
      if (categoryValue) {
        sql += ' AND category = ?';
        params.push(categoryValue);
      }
      const result = sqliteDb.prepare(sql).run(...params);
      return result.changes || 0;
    } else if (status === 'open') {
      const ticketId = await getNextTicketId();
      sqliteDb.prepare(
        'DELETE FROM supportees WHERE messenger = ? AND userid = ?'
      ).run(String(messenger), userIdValue);
      sqliteDb.prepare(
        `INSERT INTO supportees (ticketId, userid, internalIds, name, messageThreadId, messenger, status, category)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(ticketId, userIdValue, null, null, null, String(messenger), 'open', categoryValue);
      return 1;
    } else if (status === 'banned') {
      const ticketId = await getNextTicketId();
      sqliteDb.prepare(
        'DELETE FROM supportees WHERE messenger = ? AND userid = ?'
      ).run(String(messenger), userIdValue);
      sqliteDb.prepare(
        `INSERT INTO supportees (ticketId, userid, internalIds, name, messageThreadId, messenger, status, category)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(ticketId, userIdValue, null, null, null, String(messenger), 'banned', 'BANNED');
      return 1;
    }
    return 0;
  }
  let result;
  if (status === 'closed') {
    const query = {
      messenger,
      $or: [{ userid: userid }, { ticketId: userid }],
      ...(category && { category }),
    };
    result = await Supportee.updateMany(query, { $set: { status: 'closed' } });
  } else if (status === 'open') {
    let ticketId = await getNextTicketId();
    result = await Supportee.findOneAndReplace(
      { messenger, userid },
      { userid, messenger, ticketId, status, category, messageThreadId: null },
      { upsert: true }
    );
  } else if (status === 'banned') {
    result = await Supportee.findOneAndReplace(
      { messenger, userid },
      {
        userid,
        messenger,
        ticketId: await getNextTicketId(),
        messageThreadId: null,
        status: 'banned',
        category: 'BANNED',
      },
      { upsert: true }
    );
  }
  return result?.modifiedCount || 0;
};

export const open = async (
  callback: Function,
  category: string[],
) => {
  if (STORAGE_DRIVER === 'sqlite') {
    ensureSqlite();
    if (category.length > 0) {
      const placeholders = category.map(() => '?').join(', ');
      const rows = sqliteDb.prepare(
        `SELECT * FROM supportees WHERE status = ? AND category IN (${placeholders})`
      ).all('open', ...category);
      callback(rows.map(rowToSupportee));
      return;
    }
    const rows = sqliteDb.prepare(
      'SELECT * FROM supportees WHERE status = ? AND category IS NULL'
    ).all('open');
    callback(rows.map(rowToSupportee));
    return;
  }
  const query = {
    status: 'open',
    ...(category.length > 0
      ? { category: { $in: category } }
      : { category: null }),
  };
  const result = await Supportee.find(query);
  callback(result);
};
