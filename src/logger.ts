import * as fancyLog from 'fancy-log';
import cache from './cache';

type LogLevel = 'silent' | 'error' | 'info' | 'debug';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  info: 2,
  debug: 3,
};

function resolveLevel(): LogLevel {
  const raw = (cache?.config?.log_level || process.env.LOG_LEVEL || 'info')
    .toString()
    .toLowerCase();

  if (raw === 'quiet' || raw === 'none') return 'silent';
  if (raw === 'err') return 'error';
  if (raw in LEVEL_WEIGHT) return raw as LogLevel;
  return 'info';
}

function canLog(level: LogLevel): boolean {
  return LEVEL_WEIGHT[resolveLevel()] >= LEVEL_WEIGHT[level];
}

export function info(...args: any[]): void {
  if (canLog('info')) fancyLog.info(...args);
}

export function error(...args: any[]): void {
  if (canLog('error')) fancyLog.error(...args);
}

export function debug(...args: any[]): void {
  if (canLog('debug')) fancyLog.info(...args);
}

export function warn(...args: any[]): void {
  if (!canLog('info')) return;
  const warnFn = (fancyLog as any).warn;
  if (typeof warnFn === 'function') {
    warnFn(...args);
  } else {
    fancyLog.info(...args);
  }
}

