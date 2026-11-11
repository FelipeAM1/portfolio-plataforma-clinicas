import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { hashPassword } from './auth.js';

const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
const bookingSchema = await readFile(new URL('./booking.sql', import.meta.url), 'utf8');
const encounterSchema = await readFile(new URL('./encounters.sql', import.meta.url), 'utf8');

export const demoClinics = [
  { slug: 'clinica-a', name: 'Clínica Exemplo A', patients: ['Marina Exemplo', 'Lara Exemplo'] },
  { slug: 'clinica-b', name: 'Clínica Exemplo B', patients: ['Bianca Exemplo', 'Sofia Exemplo'] },
];

export async function createDatabase(demoPassword) {
  const db = await PGlite.create({ extensions: { btree_gist } });
  try {
    await db.exec(schema);
    await db.exec(bookingSchema);
    await db.exec(encounterSchema);
    await db.transaction(async (tx) => {
      for (const clinic of demoClinics) {
        const clinicId = randomUUID();
        await tx.query('INSERT INTO clinics VALUES ($1, $2, $3)', [clinicId, clinic.slug, clinic.name]);
        let professionalId;
        for (const [role, label] of [
          ['owner', 'proprietaria'],
          ['reception', 'recepcao'],
          ['professional', 'profissional'],
        ]) {
          const id = randomUUID();
          await tx.query(
            'INSERT INTO accounts (id, email, name, password_hash) VALUES ($1, $2, $3, $4)',
            [id, `${label}@${clinic.slug}.test`, `${label} · ${clinic.name}`, await hashPassword(demoPassword)],
          );
          await tx.query('INSERT INTO memberships (clinic_id, account_id, role) VALUES ($1, $2, $3)', [
            clinicId, id, role,
          ]);
          if (role === 'professional') professionalId = id;
          if (role !== 'reception') {
            const displayName = role === 'owner' ? 'Proprietária' : 'Profissional da clínica';
            await tx.query('INSERT INTO bookable_staff VALUES ($1, $2, $3)', [clinicId, id, displayName]);
            await tx.query(
              `INSERT INTO weekly_hours
               SELECT $1, gen_random_uuid(), $2, weekday, period.opens, period.closes
               FROM generate_series(1, 5) AS weekday
               CROSS JOIN (VALUES (time '09:00', time '12:00'), (time '14:00', time '18:00')) AS period(opens, closes)`,
              [clinicId, id],
            );
          }
        }
        for (const [index, patient] of clinic.patients.entries()) {
          await tx.query('INSERT INTO patients VALUES ($1, $2, $3, $4)', [
            randomUUID(), clinicId, index === 0 ? professionalId : null, patient,
          ]);
        }
        const categoryId = randomUUID();
        const serviceId = randomUUID();
        const isClinicA = clinic.slug === 'clinica-a';
        await tx.query('INSERT INTO categories (clinic_id, id, name) VALUES ($1, $2, $3)', [
          clinicId, categoryId, isClinicA ? 'Cuidados faciais' : 'Bem-estar',
        ]);
        await tx.query('INSERT INTO services (clinic_id, id, category_id, name) VALUES ($1, $2, $3, $4)', [
          clinicId, serviceId, categoryId, isClinicA ? 'Limpeza de pele' : 'Massagem relaxante',
        ]);
        await tx.query(
          `INSERT INTO service_options (clinic_id, id, service_id, name, duration, price_kind, price_cents)
           VALUES ($1, $2, $3, 'Sessão', 60, 'fixed', $4)`,
          [clinicId, randomUUID(), serviceId, isClinicA ? 18000 : 12000],
        );
        await tx.query('INSERT INTO service_staff VALUES ($1, $2, $3)', [clinicId, serviceId, professionalId]);
      }
    });
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}

export function asAuth(db, run) {
  return db.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE platform_auth');
    return run(tx);
  });
}

export async function assumeMember(tx, accountId) {
  await tx.exec('SET LOCAL ROLE platform_member');
  await tx.query("SELECT set_config('app.account_id', $1, true)", [accountId]);
}
