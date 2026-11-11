import { randomUUID } from 'node:crypto';
import { isId, nameOf, readCatalog } from './catalog.js';
import { lockBooking } from './encounters.js';
import { reject } from './request-error.js';

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const slotPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const timeZone = 'America/Bahia';
const todayFormat = new Intl.DateTimeFormat('sv-SE', { timeZone });

function validDate(day) {
  if (typeof day !== 'string' || !datePattern.test(day) || day.startsWith('0000')) return false;
  const parsed = new Date(day);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}

function bookingDates() {
  const today = todayFormat.format();
  const last = new Date(today);
  last.setUTCDate(last.getUTCDate() + 29);
  return { today, lastDay: last.toISOString().slice(0, 10) };
}

const availableSlots = `
  SELECT DISTINCT b.id AS staff_id, b.display_name,
    slot.start AT TIME ZONE '${timeZone}' AS starts_at,
    (slot.start + make_interval(mins => o.duration)) AT TIME ZONE '${timeZone}' AS ends_at,
    s.name AS service_name, o.name AS option_name
  FROM service_options o
  JOIN services s ON s.clinic_id = o.clinic_id AND s.id = o.service_id
  JOIN service_staff ss ON ss.clinic_id = s.clinic_id AND ss.service_id = s.id
  JOIN bookable_staff b ON b.clinic_id = ss.clinic_id AND b.id = ss.staff_id
  JOIN weekly_hours h ON h.clinic_id = b.clinic_id AND h.staff_id = b.id
  CROSS JOIN LATERAL generate_series(
    $3::date + h.opens,
    $3::date + h.closes - make_interval(mins => o.duration),
    interval '15 minutes'
  ) AS slot(start)
  WHERE o.clinic_id = $1 AND o.id = $2 AND h.weekday = extract(isodow FROM $3::date)
    AND slot.start AT TIME ZONE '${timeZone}' > now()
    AND NOT EXISTS (
      SELECT 1 FROM bookings r
      WHERE r.clinic_id = o.clinic_id AND r.staff_id = b.id AND r.status = 'confirmed'
        AND tstzrange(r.starts_at, r.ends_at, '[)') && tstzrange(
          slot.start AT TIME ZONE '${timeZone}',
          (slot.start + make_interval(mins => o.duration)) AT TIME ZONE '${timeZone}', '[)'
        )
    )
`;

export async function publicBooking(tx, slug, section, params, data) {
  await tx.exec('SET LOCAL ROLE platform_booking');
  const { rows: [clinic] } = await tx.query('SELECT id, name FROM clinics WHERE slug = $1', [slug]);
  if (!clinic) reject(404, 'Clínica não encontrada.');
  await tx.query("SELECT set_config('app.public_clinic_id', $1, true)", [clinic.id]);
  const dates = bookingDates();
  if (section === 'catalog') return { ...await readCatalog(tx, clinic, true), ...dates, timeZone };

  const optionId = data?.optionId ?? params.get('option');
  const date = data?.date ?? params.get('date');
  if (!isId(optionId) || !validDate(date) || date < dates.today || date > dates.lastDay) {
    reject(400, 'Escolha um serviço e uma data nos próximos 30 dias.');
  }
  const values = [clinic.id, optionId, date];
  if (section === 'slots') {
    const { rows } = await tx.query(
      `SELECT staff_id, display_name, starts_at, ends_at FROM (${availableSlots}) slots ORDER BY starts_at, display_name`,
      values,
    );
    return { slots: rows };
  }

  const { staffId, startsAt } = data;
  const patientName = nameOf(data.patientName, 'seu nome');
  const phone = typeof data.phone === 'string' && /^[+0-9 ().-]+$/.test(data.phone)
    ? data.phone.replace(/\D/g, '') : '';
  if (!isId(staffId) || typeof startsAt !== 'string' || !slotPattern.test(startsAt)
    || !Number.isFinite(new Date(startsAt).getTime()) || !/^\d{10,13}$/.test(phone)) {
    reject(400, 'Selecione um horário e informe um telefone válido com DDD.');
  }

  const id = randomUUID();
  try {
    const result = await tx.query(
      `INSERT INTO bookings (clinic_id, id, staff_id, option_id, starts_at, ends_at, service_name, option_name, patient_name, phone)
       SELECT $1, $4, staff_id, $2, starts_at, ends_at, service_name, option_name, $7, $8
       FROM (${availableSlots}) slots WHERE staff_id = $5 AND starts_at = $6`,
      [...values, id, staffId, startsAt, patientName, phone],
    );
    if (!result.affectedRows) reject(409, 'Esse horário não está mais disponível. Escolha outro.');
  } catch (error) {
    if (error.code === '23P01') reject(409, 'Esse horário acabou de ser reservado. Escolha outro.');
    throw error;
  }
  return { id, status: 'confirmed', startsAt };
}

export async function readAgenda(tx, clinic, date) {
  const day = date ?? bookingDates().today;
  if (!validDate(day)) reject(400, 'Informe uma data válida.');
  const { rows: bookings } = await tx.query(
    `SELECT r.id, r.starts_at, r.ends_at, r.service_name, r.option_name, r.patient_name, r.phone, r.status,
      s.display_name, r.starts_at > now() AS upcoming, p.patient_id,
      e.booking_id IS NOT NULL AS recorded, r.staff_id = current_account_id() AS assigned_to_me
     FROM bookings r JOIN bookable_staff s ON r.clinic_id = s.clinic_id AND r.staff_id = s.id
     LEFT JOIN booking_patients p ON p.clinic_id = r.clinic_id AND p.booking_id = r.id
     LEFT JOIN encounters e ON e.clinic_id = r.clinic_id AND e.booking_id = r.id
     WHERE r.clinic_id = $1
       AND r.starts_at >= ($2::date::timestamp AT TIME ZONE '${timeZone}')
       AND r.starts_at < (($2::date + 1)::timestamp AT TIME ZONE '${timeZone}')
     ORDER BY r.starts_at, s.display_name`, [clinic.id, day],
  );
  return { bookings, date: day, timeZone };
}

export async function cancelBooking(tx, clinic, id) {
  if (!['owner', 'reception'].includes(clinic.role)) reject(403, 'Somente a proprietária ou a recepção pode cancelar.');
  await lockBooking(tx, clinic.id, id);
  const { rows } = await tx.query('SELECT 1 FROM encounters WHERE clinic_id = $1 AND booking_id = $2', [clinic.id, id]);
  if (rows.length) reject(409, 'Esta reserva já tem atendimento registrado.');
  const result = await tx.query(
    "UPDATE bookings SET status = 'cancelled' WHERE clinic_id = $1 AND id = $2 AND status = 'confirmed' AND starts_at > now()",
    [clinic.id, id],
  );
  if (!result.affectedRows) reject(404, 'Reserva futura confirmada não encontrada.');
  return { ok: true };
}

export async function manageHours(tx, clinic, method, id, data) {
  if (clinic.role !== 'owner') reject(403, 'Somente a proprietária pode configurar horários.');
  if (method === 'GET') {
    const { rows } = await tx.query(
      `SELECT h.id, h.staff_id, h.weekday, to_char(h.opens, 'HH24:MI') AS opens, to_char(h.closes, 'HH24:MI') AS closes
       FROM weekly_hours h WHERE h.clinic_id = $1 ORDER BY h.weekday, h.opens`, [clinic.id],
    );
    return { hours: rows };
  }
  if (method === 'DELETE') {
    const result = await tx.query('DELETE FROM weekly_hours WHERE clinic_id = $1 AND id = $2', [clinic.id, id]);
    if (!result.affectedRows) reject(404, 'Horário não encontrado.');
    return { ok: true };
  }

  const { staffId, weekday, opens, closes } = data;
  if (!isId(staffId) || !Number.isInteger(weekday) || weekday < 1 || weekday > 7
    || typeof opens !== 'string' || typeof closes !== 'string'
    || !timePattern.test(opens) || !timePattern.test(closes) || opens >= closes) {
    reject(400, 'Confira a profissional, o dia e o intervalo.');
  }
  try {
    const result = await tx.query(
      `INSERT INTO weekly_hours (clinic_id, id, staff_id, weekday, opens, closes)
       SELECT $1, $2, s.id, $4, $5, $6 FROM bookable_staff s
       WHERE s.clinic_id = $1 AND s.id = $3 AND staff_is_bookable(s.clinic_id, s.id)`,
      [clinic.id, randomUUID(), staffId, weekday, opens, closes],
    );
    if (!result.affectedRows) reject(400, 'Selecione uma profissional ativa desta clínica.');
  } catch (error) {
    if (error.code === '23505') reject(409, 'Esse horário já está cadastrado.');
    throw error;
  }
  return { ok: true };
}
