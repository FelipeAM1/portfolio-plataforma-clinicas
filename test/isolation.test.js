import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { assumeMember, createDatabase } from '../src/database.js';
import { createServer } from '../src/server.js';
import { sessionHash } from '../src/auth.js';

test('Sessões e isolamento entre clínicas', async (t) => {
  const password = randomBytes(15).toString('base64url');
  const db = await createDatabase(password);
  let server;
  t.after(async () => {
    if (server?.listening) {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
    await db.close();
  });
  server = await createServer(db);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(path, { cookie, method = 'GET', data, origin = base } = {}) {
    const headers = { Origin: origin };
    if (cookie) headers.Cookie = cookie;
    if (data) headers['Content-Type'] = 'application/json';
    return fetch(base + path, { method, headers, body: data ? JSON.stringify(data) : undefined });
  }

  async function signIn(email, givenPassword = password) {
    return request('/api/login', { method: 'POST', data: { email, password: givenPassword } });
  }

  async function login(email) {
    const response = await signIn(email);
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie');
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) {
      assert.ok(cookie.split('; ').includes(attribute), attribute);
    }
    assert.deepEqual(await response.json(), { ok: true });
    return cookie.split(';')[0];
  }

  await t.test('visitante e senha incorreta não entram', async () => {
    assert.equal((await request('/api/me')).status, 401);
    assert.equal((await signIn('proprietaria@clinica-a.test', 'senha inválida')).status, 401);
    assert.equal((await request('/.git/config')).status, 404);
  });

  const owner = await login('proprietaria@clinica-a.test');
  const reception = await login('recepcao@clinica-a.test');
  const professional = await login('profissional@clinica-a.test');
  const otherOwner = await login('proprietaria@clinica-b.test');
  const patientsA = '/api/clinics/clinica-a/patients';
  const patientsB = '/api/clinics/clinica-b/patients';
  const { patients: rowsA } = await (await request(patientsA, { cookie: owner })).json();
  const { patients: rowsB } = await (await request(patientsB, { cookie: otherOwner })).json();
  const assigned = rowsA.find((row) => row.name === 'Marina Exemplo');
  const unassigned = rowsA.find((row) => row.name === 'Lara Exemplo');
  const other = rowsB[0];

  await t.test('conta lista apenas vínculos e pacientes da própria clínica', async () => {
    const response = await request('/api/me', { cookie: owner });
    const account = await response.json();
    assert.deepEqual(account.clinics.map(({ slug }) => slug), ['clinica-a']);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(rowsA.length, 2);
    assert.equal(rowsB.length, 2);
    assert.equal((await request(patientsB, { cookie: owner })).status, 404);
    assert.equal((await request(`${patientsA}/${other.id}`, { cookie: owner })).status, 404);
    assert.equal((await request(`${patientsA}/${other.id}`, {
      cookie: owner, method: 'PATCH', data: { name: 'Tentativa cruzada' },
    })).status, 404);
  });

  await t.test('profissional só lê pacientes atribuídos e recepção edita cadastro', async () => {
    const response = await request(patientsA, { cookie: professional });
    assert.deepEqual((await response.json()).patients, [assigned]);
    assert.equal((await request(`${patientsA}/${unassigned.id}`, { cookie: professional })).status, 404);
    const path = `${patientsA}/${assigned.id}`;
    const change = { method: 'PATCH', data: { name: 'Marina Atualizada' } };
    assert.equal((await request(path, { cookie: professional, ...change })).status, 403);
    const updated = await request(path, { cookie: reception, ...change });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).name, 'Marina Atualizada');
    assert.equal((await request(path, {
      cookie: reception, method: 'PATCH', data: { name: 'Marina', role: 'owner' },
    })).status, 400);
  });

  await t.test('somente proprietária edita clínica e requisição externa é rejeitada', async () => {
    const path = '/api/clinics/clinica-a';
    const change = { method: 'PATCH', data: { name: 'Clínica Exemplo A Teste' } };
    assert.equal((await request(path, { cookie: reception, ...change })).status, 403);
    assert.equal((await request(path, { cookie: owner, origin: 'https://outra-origem.test', ...change })).status, 403);
    assert.equal((await request(path, { cookie: owner, ...change })).status, 200);
  });

  const { rows: [ownerAccount] } = await db.query("SELECT id FROM accounts WHERE email = 'proprietaria@clinica-a.test'");

  const clinicA = '/api/clinics/clinica-a';
  const publicA = '/api/public/clinics/clinica-a';
  const publicB = '/api/public/clinics/clinica-b';
  const publicCatalog = await (await request(`${publicA}/catalog`)).json();
  const optionId = publicCatalog.options[0].id;
  const tomorrow = new Date(publicCatalog.today);
  do {
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  } while ([0, 6].includes(tomorrow.getUTCDay()));
  const date = tomorrow.toISOString().slice(0, 10);
  const slotQuery = `/slots?option=${optionId}&date=${date}`;
  const agenda = `/agenda?date=${date}`;

  await t.test('catálogo pode ser configurado pela proprietária e só publica opções ativas', async () => {
    const otherCatalog = await (await request(`${publicB}/catalog`)).json();
    assert.equal(publicCatalog.services[0].name, 'Limpeza de pele');
    assert.equal(otherCatalog.services[0].name, 'Massagem relaxante');
    assert.equal((await request(`${clinicA}/catalog`)).status, 401);
    const category = { method: 'POST', data: { name: 'Hidratação', parentId: publicCatalog.categories[0].id } };
    assert.equal((await request(`${clinicA}/categories`, { ...category, cookie: reception })).status, 403);
    assert.equal((await request(`${clinicA}/categories`, { ...category, cookie: otherOwner })).status, 404);
    assert.equal((await request(`${clinicA}/categories`, { ...category, cookie: owner })).status, 201);
    const catalog = await (await request(`${clinicA}/catalog`, { cookie: owner })).json();
    const subcategory = catalog.categories.find(({ name }) => name === 'Hidratação');
    const service = { name: 'Hidratação facial', categoryId: subcategory.id, staffIds: [catalog.staff[0].id], active: true };
    assert.equal((await request(`${clinicA}/services`, { method: 'POST', cookie: owner, data: service })).status, 201);
    const updated = await (await request(`${clinicA}/catalog`, { cookie: owner })).json();
    const serviceId = updated.services.find(({ name }) => name === service.name).id;
    const option = { serviceId, name: 'Pacote', duration: 45, priceKind: 'from', priceCents: 25000, active: false };
    assert.equal((await request(`${clinicA}/options`, { method: 'POST', cookie: owner, data: option })).status, 201);
    const visible = await (await request(`${publicA}/catalog`)).json();
    assert.deepEqual(visible.options.map(({ id }) => id), [optionId]);
    assert.equal((await request(`${clinicA}/hours`, { cookie: reception })).status, 403);
    const hours = await request(`${clinicA}/hours`, { cookie: owner });
    assert.equal(hours.status, 200);
    assert.ok((await hours.json()).hours.length);
  });

  await t.test('agendamentos simultâneos não se sobrepõem e a equipe vê somente suas reservas', async () => {
    const availability = await request(publicA + slotQuery);
    assert.equal(availability.status, 200);
    const { slots } = await availability.json();
    assert.ok(slots.length >= 2);
    const { slots: foreignSlots } = await (await request(publicB + slotQuery)).json();
    assert.deepEqual(foreignSlots, []);
    const book = (slot) => request(`${publicA}/bookings`, {
      method: 'POST',
      data: { optionId, date, startsAt: slot.starts_at, staffId: slot.staff_id, patientName: 'Paciente Fictícia', phone: '71000000000' },
    });
    const attempts = await Promise.all(slots.slice(0, 2).map(book));
    assert.deepEqual(attempts.map(({ status }) => status).sort(), [201, 409]);
    const confirmation = await attempts.find(({ status }) => status === 201).json();
    assert.equal(confirmation.status, 'confirmed');
    assert.equal(Object.hasOwn(confirmation, 'phone'), false);
    const { bookings: visible } = await (await request(clinicA + agenda, { cookie: professional })).json();
    assert.deepEqual(visible.map(({ id }) => id), [confirmation.id]);
    assert.equal((await request(clinicA + agenda)).status, 401);
    assert.equal((await request(clinicA + agenda, { cookie: otherOwner })).status, 404);
    assert.deepEqual((await (await request('/api/clinics/clinica-b' + agenda, { cookie: otherOwner })).json()).bookings, []);
    const cancelPath = `${clinicA}/bookings/${confirmation.id}`;
    assert.equal((await request(cancelPath, { method: 'DELETE', cookie: professional })).status, 403);
    assert.equal((await request(cancelPath, { method: 'DELETE', cookie: reception })).status, 200);
    assert.equal((await book(slots[0])).status, 201);
  });

  await t.test('o banco rejeita sobreposição mesmo se a aplicação esquecer a consulta de horários', async () => {
    await assert.rejects(db.query(
      `INSERT INTO bookings
       SELECT clinic_id, gen_random_uuid(), staff_id, option_id, starts_at + interval '1 minute', ends_at,
         service_name, option_name, 'Outro Cadastro', '71000000000', status
       FROM bookings WHERE status = 'confirmed' LIMIT 1`,
    ), { code: '23P01', constraint: 'no_overlapping_booking' });
    await assert.rejects(db.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE platform_booking');
      await tx.query('SELECT phone FROM bookings');
    }), { code: '42501' });
  });

  await t.test('RLS impede leitura e escrita cruzadas mesmo sem o filtro da API', async () => {
    await db.transaction(async (tx) => {
      await assumeMember(tx, ownerAccount.id);
      assert.equal((await tx.query('SELECT id FROM patients WHERE id = $1', [other.id])).rows.length, 0);
      assert.equal((await tx.query('SELECT id FROM patients')).rows.length, 2);
      const update = await tx.query("UPDATE patients SET name = 'Tentativa' WHERE id = $1 RETURNING id", [other.id]);
      assert.equal(update.rows.length, 0);
    });
    await assert.rejects(db.transaction(async (tx) => {
      await assumeMember(tx, ownerAccount.id);
      await tx.query('SELECT password_hash FROM accounts');
    }), { code: '42501' });
    await db.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE platform_member');
      assert.equal((await tx.query('SELECT id FROM patients')).rows.length, 0);
    });
  });

  await t.test('vincula uma reserva à ficha e registra atendimento apenas com a profissional designada', async () => {
    const { bookings } = await (await request(clinicA + agenda, { cookie: owner })).json();
    const booking = bookings.find(({ status }) => status === 'confirmed');
    const link = `${clinicA}/booking-patients/${booking.id}`;
    const record = `${clinicA}/encounters/${booking.id}`;
    const details = { procedure: 'Limpeza de pele', complaint: 'Pele ressecada', allergies: '', notes: 'Dados de teste' };
    const post = (path, cookie, data) => request(path, { method: 'POST', cookie, data });
    assert.equal((await post(record, professional, details)).status, 409);
    assert.equal((await post(link, professional, { patientId: assigned.id })).status, 403);
    assert.equal((await post(link, reception, { patientId: other.id })).status, 404);
    assert.equal((await post(link, reception, { patientId: unassigned.id })).status, 404);
    const created = await Promise.all([post(link, reception, { patientId: null }), post(link, owner, { patientId: null })]);
    assert.deepEqual(created.map(({ status }) => status), [201, 201]);
    const [first, second] = await Promise.all(created.map((response) => response.json()));
    assert.equal(first.patientId, second.patientId);
    assert.equal((await post(link, owner, { patientId: assigned.id })).status, 409);
    const { patients: updated } = await (await request(patientsA, { cookie: owner })).json();
    assert.equal(updated.length, rowsA.length + 1);
    assert.equal((await post(record, reception, details)).status, 403);
    assert.equal((await post(record, owner, details)).status, 403);
    assert.equal((await post(record, professional, details)).status, 201);
    assert.equal((await post(record, professional, details)).status, 409);
    assert.equal((await request(`${clinicA}/bookings/${booking.id}`, { method: 'DELETE', cookie: owner })).status, 409);
    const history = `${clinicA}/patient-history/${first.patientId}`;
    assert.equal((await request(history)).status, 401);
    assert.equal((await request(history, { cookie: otherOwner })).status, 404);
    assert.equal((await request(`/api/clinics/clinica-b/patient-history/${first.patientId}`, { cookie: otherOwner })).status, 404);
    for (const cookie of [owner, reception, professional]) {
      const { patient, encounters } = await (await request(history, { cookie })).json();
      assert.equal(patient.name, 'Paciente Fictícia');
      assert.equal(encounters.length, 1);
      assert.equal(encounters[0].complaint, details.complaint);
    }
    await assert.rejects(db.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE platform_booking');
      await tx.query('SELECT procedure FROM encounters');
    }), { code: '42501' });
  });

  await t.test('remoção de vínculo e encerramento de sessão têm efeito no servidor', async () => {
    await db.query('UPDATE memberships SET active = false WHERE account_id = $1', [ownerAccount.id]);
    assert.equal((await request(patientsA, { cookie: owner })).status, 404);
    assert.deepEqual((await (await request('/api/me', { cookie: owner })).json()).clinics, []);
    assert.equal((await request('/api/logout', { method: 'POST', cookie: owner })).status, 200);
    assert.equal((await request('/api/me', { cookie: owner })).status, 401);
  });

  await t.test('sessão inativa expira mesmo com o cookie presente', async () => {
    const token = otherOwner.split('=')[1];
    await db.query("UPDATE sessions SET idle_until = now() - interval '1 second' WHERE token_hash = $1", [
      sessionHash(token),
    ]);
    assert.equal((await request('/api/me', { cookie: otherOwner })).status, 401);
  });
});
