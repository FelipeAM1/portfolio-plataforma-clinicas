import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const deriveKey = promisify(scrypt);
const scryptOptions = { N: 2 ** 16, r: 8, p: 2, maxmem: 96 * 1024 * 1024 };

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, 64, scryptOptions);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

export async function checkPassword(password, storedHash) {
  const [salt, key] = storedHash.split(':');
  const actual = await deriveKey(password, Buffer.from(salt, 'hex'), 64, scryptOptions);
  return timingSafeEqual(actual, Buffer.from(key, 'hex'));
}

export function sessionHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function readSession(cookie = '') {
  const token = /(?:^|;\s*)__Host-platform_session=([\w-]{43})(?=;|$)/.exec(cookie)?.[1];
  return token ? sessionHash(token) : null;
}

export function sessionCookie(token, seconds) {
  return `__Host-platform_session=${token}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Lax`;
}
