import { randomUUID } from 'node:crypto';
import { isId } from './catalog.js';
import { reject } from './request-error.js';

export function lockBooking(tx, clinicId, bookingId) {
  return tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::text, 0))", [clinicId, bookingId]);
}

async function findBooking(tx, clinic, id) {
  const { rows: [booking] } = await tx.query(
    `SELECT b.staff_id, b.status, b.patient_name, p.patient_id, b.staff_id = current_account_id() AS assigned_to_me
     FROM bookings b LEFT JOIN booking_patients p ON p.clinic_id = b.clinic_id AND p.booking_id = b.id
     WHERE b.clinic_id = $1 AND b.id = $2`, [clinic.id, id],
  );
  if (!booking) reject(404, 'Reserva não encontrada.');
  return booking;
}

export async function bookingPatient(tx, clinic, method, id, data) {
  if (!['owner', 'reception'].includes(clinic.role)) reject(403, 'Somente proprietária e recepção podem vincular cadastros.');
  if (method === 'POST') await lockBooking(tx, clinic.id, id);
  const booking = await findBooking(tx, clinic, id);
  if (booking.status !== 'confirmed') reject(409, 'A reserva precisa estar confirmada.');

  if (method === 'GET') {
    const { rows: patients } = await tx.query(
      'SELECT id, name FROM patients WHERE clinic_id = $1 AND professional_id = $2 ORDER BY name, id',
      [clinic.id, booking.staff_id],
    );
    return { patients, patientId: booking.patient_id };
  }

  const { patientId } = data;
  if (Object.keys(data).length !== 1 || (patientId !== null && !isId(patientId))) {
    reject(400, 'Selecione um cadastro ou escolha criar um novo.');
  }
  if (booking.patient_id) {
    if (patientId === null || patientId === booking.patient_id) return { patientId: booking.patient_id };
    reject(409, 'Esta reserva já está vinculada a um cadastro.');
  }
  if (!patientId) {
    if (!(await tx.query('SELECT staff_is_bookable($1, $2) AS active', [clinic.id, booking.staff_id])).rows[0].active) {
      reject(409, 'A profissional desta reserva está inativa.');
    }
    const newId = randomUUID();
    await tx.query('INSERT INTO patients (clinic_id, id, professional_id, name) VALUES ($1, $2, $3, $4)', [
      clinic.id, newId, booking.staff_id, booking.patient_name,
    ]);
    await tx.query('INSERT INTO booking_patients VALUES ($1, $2, $3)', [clinic.id, id, newId]);
    return { patientId: newId };
  }
  const result = await tx.query(
    `INSERT INTO booking_patients (clinic_id, booking_id, patient_id)
     SELECT clinic_id, $2, id FROM patients WHERE clinic_id = $1 AND id = $3 AND professional_id = $4`,
    [clinic.id, id, patientId, booking.staff_id],
  );
  if (!result.affectedRows) reject(404, 'Cadastro não encontrado entre as pacientes desta profissional.');
  return { patientId };
}

function clinicalText(value, required = false) {
  const text = typeof value === 'string' ? value.trim() : null;
  if (text === null || text.length > 220 || (required && text.length < 2) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text)) {
    reject(400, 'Informe o procedimento e use até 220 caracteres por campo.');
  }
  return text;
}

export async function recordEncounter(tx, clinic, bookingId, data) {
  if (clinic.role === 'reception') reject(403, 'O atendimento deve ser registrado por quem está na reserva.');
  const fields = ['procedure', 'complaint', 'allergies', 'notes'];
  if (Object.keys(data).length !== fields.length) reject(400, 'Confira os campos da ficha.');
  const values = fields.map((field) => clinicalText(data[field], field === 'procedure'));
  await lockBooking(tx, clinic.id, bookingId);
  const booking = await findBooking(tx, clinic, bookingId);
  if (!booking.assigned_to_me) reject(403, 'O atendimento deve ser registrado por quem está na reserva.');
  if (booking.status !== 'confirmed' || !booking.patient_id) reject(409, 'Vincule o cadastro a uma reserva confirmada.');
  const result = await tx.query(
    `INSERT INTO encounters (clinic_id, booking_id, procedure, complaint, allergies, notes)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (clinic_id, booking_id) DO NOTHING`,
    [clinic.id, bookingId, ...values],
  );
  if (!result.affectedRows) reject(409, 'Este atendimento já foi registrado.');
  return { patientId: booking.patient_id };
}

export async function readPatientHistory(tx, clinic, patientId) {
  const { rows: [patient] } = await tx.query('SELECT id, name FROM patients WHERE clinic_id = $1 AND id = $2', [
    clinic.id, patientId,
  ]);
  if (!patient) reject(404, 'Cadastro não encontrado.');
  const { rows: encounters } = await tx.query(
    `SELECT e.procedure, e.complaint, e.allergies, e.notes, e.recorded_at, b.starts_at, s.display_name
     FROM booking_patients p
     JOIN encounters e ON e.clinic_id = p.clinic_id AND e.booking_id = p.booking_id
     LEFT JOIN bookings b ON b.clinic_id = e.clinic_id AND b.id = e.booking_id
     LEFT JOIN bookable_staff s ON s.clinic_id = e.clinic_id AND s.id = e.author_id
     WHERE p.clinic_id = $1 AND p.patient_id = $2
     ORDER BY e.recorded_at DESC, e.booking_id`, [clinic.id, patientId],
  );
  return { patient, encounters };
}
