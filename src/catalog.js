import { randomUUID } from 'node:crypto';
import { reject } from './request-error.js';

export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isId = (value) => typeof value === 'string' && uuidPattern.test(value);

export function nameOf(value, label = 'nome', limit = 100) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name.length < 2 || name.length > limit || /[\u0000-\u001f\u007f]/u.test(name)) {
    reject(400, `Informe ${label} com 2 a ${limit} caracteres.`);
  }
  return name;
}

export async function readCatalog(tx, clinic, publicView) {
  const { rows: categories } = await tx.query(
    'SELECT id, parent_id, name FROM categories WHERE clinic_id = $1 ORDER BY name', [clinic.id],
  );
  const { rows: services } = await tx.query(
    'SELECT id, category_id, name, active FROM services WHERE clinic_id = $1 ORDER BY name', [clinic.id],
  );
  const { rows: options } = await tx.query(
    `SELECT id, service_id, name, duration, price_kind, price_cents, price_unit, active
     FROM service_options WHERE clinic_id = $1 ORDER BY name`, [clinic.id],
  );
  if (publicView) return { name: clinic.name, categories, services, options };
  const { rows: staff } = await tx.query(
    `SELECT id, display_name FROM bookable_staff
     WHERE clinic_id = $1 AND staff_is_bookable(clinic_id, id) ORDER BY display_name`, [clinic.id],
  );
  const { rows: assignments } = await tx.query(
    'SELECT service_id, staff_id FROM service_staff WHERE clinic_id = $1', [clinic.id],
  );
  return { categories, services, options, staff, assignments };
}

async function saveCategory(tx, clinicId, id, data) {
  const name = nameOf(data.name, 'o nome da categoria');
  if (id) {
    return tx.query('UPDATE categories SET name = $3 WHERE clinic_id = $1 AND id = $2', [clinicId, id, name]);
  }
  const parent = data.parentId || null;
  if (parent && !isId(parent)) reject(400, 'Selecione uma categoria principal.');
  return tx.query('INSERT INTO categories (clinic_id, id, name, parent_id) VALUES ($1, $2, $3, $4)', [
    clinicId, randomUUID(), name, parent,
  ]);
}

async function saveService(tx, clinicId, id, data) {
  const name = nameOf(data.name, 'o nome do serviço');
  const { categoryId, active, staffIds } = data;
  if (!isId(categoryId) || typeof active !== 'boolean' || !Array.isArray(staffIds)
    || staffIds.length > 30 || !staffIds.every(isId)) reject(400, 'Confira a categoria e as profissionais.');
  const serviceId = id ?? randomUUID();
  const values = [clinicId, serviceId, categoryId, name, active];
  const result = id
    ? await tx.query('UPDATE services SET category_id = $3, name = $4, active = $5 WHERE clinic_id = $1 AND id = $2', values)
    : await tx.query('INSERT INTO services (clinic_id, id, category_id, name, active) VALUES ($1, $2, $3, $4, $5)', values);
  if (!result.affectedRows) return result;
  await tx.query('DELETE FROM service_staff WHERE clinic_id = $1 AND service_id = $2', [clinicId, serviceId]);
  const assignments = [...new Set(staffIds)];
  const linked = await tx.query(
    `INSERT INTO service_staff
     SELECT $1, $2, staff.id FROM bookable_staff staff
     WHERE staff.clinic_id = $1 AND staff.id = ANY($3::uuid[]) AND staff_is_bookable(staff.clinic_id, staff.id)`,
    [clinicId, serviceId, assignments],
  );
  if (linked.affectedRows !== assignments.length) reject(400, 'Selecione profissionais ativas desta clínica.');
  return result;
}

function saveOption(tx, clinicId, id, data) {
  const name = nameOf(data.name, 'o nome da opção');
  const { duration, priceKind, priceCents, active, serviceId } = data;
  if (!Number.isInteger(duration) || duration < 15 || duration > 480 || typeof active !== 'boolean'
    || !['fixed', 'from', 'unit', 'quote'].includes(priceKind)) reject(400, 'Confira a duração, o preço e a situação da opção.');
  if (priceKind !== 'quote' && (!Number.isInteger(priceCents) || priceCents < 0 || priceCents > 99999999)) {
    reject(400, 'Informe um preço válido.');
  }
  const unit = priceKind === 'unit' ? nameOf(data.priceUnit, 'a unidade de cobrança', 30) : null;
  const values = [clinicId, id ?? randomUUID(), name, duration, priceKind, priceKind === 'quote' ? null : priceCents, unit, active];
  if (id) {
    return tx.query(
      `UPDATE service_options SET name = $3, duration = $4, price_kind = $5, price_cents = $6, price_unit = $7, active = $8
       WHERE clinic_id = $1 AND id = $2`, values,
    );
  }
  if (!isId(serviceId)) reject(400, 'Selecione um serviço.');
  return tx.query(
    `INSERT INTO service_options (clinic_id, id, name, duration, price_kind, price_cents, price_unit, active, service_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [...values, serviceId],
  );
}

export async function changeCatalog(tx, clinic, section, id, data) {
  if (clinic.role !== 'owner') reject(403, 'Somente a proprietária pode editar o catálogo.');
  const save = { categories: saveCategory, services: saveService, options: saveOption }[section];
  try {
    const result = await save(tx, clinic.id, id, data);
    if (!result.affectedRows) reject(404, 'Item não encontrado.');
  } catch (error) {
    if (error.code === '23505') reject(409, 'Já existe um item com esse nome nesse grupo.');
    if (error.code === '23503') reject(400, 'Confira se a categoria, o serviço e as profissionais pertencem a esta clínica.');
    throw error;
  }
  return { ok: true };
}
