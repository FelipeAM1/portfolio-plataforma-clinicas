import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { checkPassword, hashPassword, readSession, sessionCookie, sessionHash } from './auth.js';
import { asAuth, assumeMember } from './database.js';
import { cancelBooking, manageHours, publicBooking, readAgenda } from './booking.js';
import { changeCatalog, readCatalog } from './catalog.js';
import { bookingPatient, readPatientHistory, recordEncounter } from './encounters.js';
import { RequestError, reject } from './request-error.js';

const MAX_BODY_BYTES = 4096;
const SESSION_SECONDS = 8 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const staticFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/panel.js': ['panel.js', 'text/javascript; charset=utf-8'],
  '/panel.css': ['panel.css', 'text/css; charset=utf-8'],
  '/clinic-tools.js': ['clinic-tools.js', 'text/javascript; charset=utf-8'],
  '/care.js': ['care.js', 'text/javascript; charset=utf-8'],
  '/client.js': ['client.js', 'text/javascript; charset=utf-8'],
  '/booking.js': ['booking.js', 'text/javascript; charset=utf-8'],
  '/clinica/': ['booking.html', 'text/html; charset=utf-8'],
};
const clinicRoute = /^\/api\/clinics\/([a-z0-9-]+)(?:\/(patients|catalog|categories|services|options|agenda|bookings|hours|booking-patients|encounters|patient-history)(?:\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?)?$/;
const bookingRoute = /^\/api\/public\/clinics\/([a-z0-9-]+)\/(catalog|slots|bookings)$/;

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  const type = req.headers['content-type']?.split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') reject(415, 'Envie dados em JSON.');
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) reject(413, 'Dados acima do limite.');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) reject(413, 'Dados acima do limite.');
    chunks.push(chunk);
  }
  let data;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    reject(400, 'Dados inválidos.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) reject(400, 'Dados inválidos.');
  return data;
}

async function signIn(db, req, res, verifyLogin, dummyHash) {
  const { email, password } = await readJson(req);
  if (typeof email !== 'string' || typeof password !== 'string' || email.length > 254 || password.length > 128) {
    reject(400, 'Informe e-mail e senha válidos.');
  }

  const account = await verifyLogin(async () => {
    const { rows } = await asAuth(db, (tx) => tx.query(
      'SELECT id, password_hash FROM accounts WHERE email = $1 AND active',
      [email.trim().toLowerCase()],
    ));
    const user = rows[0];
    const matches = await checkPassword(password, user?.password_hash ?? dummyHash);
    if (!matches || !user) reject(401, 'E-mail ou senha incorretos.');
    return user;
  });

  const token = randomBytes(32).toString('base64url');
  const previous = readSession(req.headers.cookie);
  await asAuth(db, async (tx) => {
    await tx.query('DELETE FROM sessions WHERE expires_at <= now() OR idle_until <= now() OR token_hash = $1', [
      previous,
    ]);
    await tx.query(
      "INSERT INTO sessions VALUES ($1, $2, now() + interval '8 hours', now() + interval '30 minutes')",
      [sessionHash(token), account.id],
    );
  });
  res.setHeader('Set-Cookie', sessionCookie(token, SESSION_SECONDS));
  send(res, 200, { ok: true });
}

function memberRequest(db, req, action) {
  const token = readSession(req.headers.cookie);
  if (!token) reject(401, 'Entre na sua conta.');
  return asAuth(db, async (tx) => {
    const { rows } = await tx.query(
      `SELECT a.id, a.name FROM sessions s JOIN accounts a ON a.id = s.account_id
       WHERE s.token_hash = $1 AND a.active AND s.expires_at > now() AND s.idle_until > now()`,
      [token],
    );
    const account = rows[0];
    if (!account) reject(401, 'Sessão encerrada. Entre novamente.');
    await tx.query("UPDATE sessions SET idle_until = now() + interval '30 minutes' WHERE token_hash = $1", [
      token,
    ]);
    await assumeMember(tx, account.id);
    return action(tx, account);
  });
}

async function currentClinics(tx) {
  const { rows } = await tx.query(
    'SELECT c.slug, c.name, m.role FROM clinics c JOIN memberships m ON c.id = m.clinic_id ORDER BY c.name',
  );
  return rows;
}

async function clinicRequest(tx, req, slug, id, section, data, params) {
  const { rows: [clinic] } = await tx.query(
    'SELECT c.id, c.slug, c.name, m.role FROM clinics c JOIN memberships m ON c.id = m.clinic_id WHERE c.slug = $1',
    [slug],
  );
  if (!clinic) reject(404, 'Clínica não encontrada.');
  const { method } = req;

  if (section === 'catalog' && method === 'GET' && !id) return readCatalog(tx, clinic, false);
  if (section === 'agenda' && method === 'GET' && !id) return readAgenda(tx, clinic, params.get('date'));
  if (section === 'bookings' && method === 'DELETE' && id) return cancelBooking(tx, clinic, id);
  if (section === 'booking-patients' && id && ['GET', 'POST'].includes(method)) {
    return bookingPatient(tx, clinic, method, id, data);
  }
  if (section === 'encounters' && id && method === 'POST') return recordEncounter(tx, clinic, id, data);
  if (section === 'patient-history' && id && method === 'GET') return readPatientHistory(tx, clinic, id);
  if (section === 'hours' && ((['GET', 'POST'].includes(method) && !id) || (method === 'DELETE' && id))) {
    return manageHours(tx, clinic, method, id, data);
  }
  if (['categories', 'services', 'options'].includes(section) && ((method === 'POST' && !id) || (method === 'PATCH' && id))) {
    return changeCatalog(tx, clinic, section, id, data);
  }

  if (method === 'GET' && section === 'patients') {
    const { rows } = await tx.query(
      'SELECT id, name FROM patients WHERE clinic_id = $1 AND ($2::uuid IS NULL OR id = $2) ORDER BY name',
      [clinic.id, id ?? null],
    );
    if (!id) return { patients: rows };
    if (!rows[0]) reject(404, 'Cadastro não encontrado.');
    return rows[0];
  }

  if (method === 'PATCH' && ((section === 'patients' && id) || !section)) {
    const allowed = id ? ['owner', 'reception'] : ['owner'];
    if (!allowed.includes(clinic.role)) reject(403, 'Acesso insuficiente para esta alteração.');
    const name = typeof data.name === 'string' ? data.name.trim() : '';
    if (Object.keys(data).length !== 1 || name.length < 2 || name.length > 100 || /[\u0000-\u001f\u007f]/u.test(name)) {
      reject(400, 'Informe um nome entre 2 e 100 caracteres.');
    }
    const { rows } = id
      ? await tx.query('UPDATE patients SET name = $1 WHERE clinic_id = $2 AND id = $3 RETURNING id, name', [
        name, clinic.id, id,
      ])
      : await tx.query('UPDATE clinics SET name = $1 WHERE id = $2 RETURNING slug, name', [name, clinic.id]);
    if (!rows[0]) reject(404, 'Cadastro não encontrado.');
    return rows[0];
  }
  reject(404, 'Rota não encontrada.');
}

export async function createServer(db) {
  const assets = new Map();
  for (const [route, [file, type]] of Object.entries(staticFiles)) {
    assets.set(route, { type, body: await readFile(new URL(`../public/${file}`, import.meta.url)) });
  }
  const dummyHash = await hashPassword(randomBytes(24).toString('base64url'));
  let attempts = 0;
  let windowStarted = 0;
  let loginsInFlight = 0;

  async function verifyLogin(run) {
    const now = Date.now();
    if (now - windowStarted >= LOGIN_WINDOW_MS) {
      windowStarted = now;
      attempts = 0;
    }
    if (attempts >= 30 || loginsInFlight >= 2) reject(429, 'Muitas tentativas. Aguarde e tente novamente.');
    attempts++;
    loginsInFlight++;
    try {
      return await run();
    } finally {
      loginsInFlight--;
    }
  }

  const server = createHttpServer({ requestTimeout: 15000, headersTimeout: 10000 }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );

    try {
      const host = `127.0.0.1:${server.address().port}`;
      if (req.headers.host !== host) reject(400, 'Endereço inválido.');
      const origin = `http://${host}`;
      if (req.method !== 'GET' && req.headers.origin !== origin) reject(403, 'Origem não permitida.');
      const { pathname: path, searchParams } = new URL(req.url, origin);
      const assetPath = /^\/clinica\/[a-z0-9-]+$/.test(path) ? '/clinica/' : path;
      const asset = req.method === 'GET' ? assets.get(assetPath) : null;
      if (asset) {
        res.writeHead(200, { 'Content-Type': asset.type });
        res.end(asset.body);
        return;
      }

      if (path === '/api/login' && req.method === 'POST') {
        await signIn(db, req, res, verifyLogin, dummyHash);
        return;
      }
      if (path === '/api/logout' && req.method === 'POST') {
        const token = readSession(req.headers.cookie);
        if (token) await asAuth(db, (tx) => tx.query('DELETE FROM sessions WHERE token_hash = $1', [token]));
        res.setHeader('Set-Cookie', sessionCookie('', 0));
        send(res, 200, { ok: true });
        return;
      }
      if (path === '/api/me' && req.method === 'GET') {
        const account = await memberRequest(db, req, async (tx, user) => ({
          name: user.name, clinics: await currentClinics(tx),
        }));
        send(res, 200, account);
        return;
      }
      const publicMatch = bookingRoute.exec(path);
      if (publicMatch) {
        const [, slug, section] = publicMatch;
        const booking = section === 'bookings';
        if (req.method !== (booking ? 'POST' : 'GET')) reject(404, 'Rota não encontrada.');
        const data = booking ? await readJson(req) : null;
        const result = await db.transaction((tx) => publicBooking(tx, slug, section, searchParams, data));
        send(res, booking ? 201 : 200, result);
        return;
      }
      const match = clinicRoute.exec(path);
      if (match) {
        const [, slug, section, id] = match;
        const data = ['PATCH', 'POST'].includes(req.method) ? await readJson(req) : null;
        const result = await memberRequest(db, req, (tx) => clinicRequest(tx, req, slug, id, section, data, searchParams));
        send(res, req.method === 'POST' ? 201 : 200, result);
        return;
      }
      reject(404, 'Rota não encontrada.');
    } catch (error) {
      if (!req.complete) {
        res.setHeader('Connection', 'close');
        req.resume();
      }
      if (error instanceof RequestError) {
        send(res, error.status, { error: error.message });
      } else {
        console.error('Falha ao processar a requisição.', error.code ?? error.name);
        send(res, 500, { error: 'Não foi possível concluir a operação.' });
      }
    }
  });
  return server;
}
