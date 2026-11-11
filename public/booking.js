import { api, categoryLabel, element, priceLabel, timeLabel } from './client.js';

const form = document.querySelector('#booking-form');
const option = document.querySelector('#option');
const date = document.querySelector('#date');
const slot = document.querySelector('#slot');
const status = document.querySelector('#slots-status');
const submit = document.querySelector('#confirm-booking');
const result = document.querySelector('#booking-result');
const errorNotice = document.querySelector('#booking-error');
const base = `/api/public/clinics/${location.pathname.split('/').at(-1)}`;
let slots = [];
let requestVersion = 0;
let submitting = false;
let timeZone;

function showError(text = '') {
  errorNotice.textContent = text;
  errorNotice.hidden = !text;
}

async function loadSlots() {
  const version = ++requestVersion;
  slot.replaceChildren(new Option('Escolha um horário', ''));
  slots = [];
  slot.disabled = true;
  submit.disabled = true;
  status.textContent = '';
  if (!option.value || !date.value || !date.validity.valid) return;

  status.textContent = 'Buscando horários…';
  try {
    const params = new URLSearchParams({ option: option.value, date: date.value });
    const response = await api(`${base}/slots?${params}`);
    if (version !== requestVersion) return;
    slots = response.slots;
    for (const [index, item] of slots.entries()) {
      const time = timeLabel(item.starts_at, timeZone);
      slot.add(new Option(`${time} · ${item.display_name}`, String(index)));
    }
    status.textContent = slots.length ? '' : 'Sem horários disponíveis nesta data.';
    slot.disabled = !slots.length || submitting;
  } catch (error) {
    if (version === requestVersion) status.textContent = error.status ? error.message : 'Não foi possível buscar os horários.';
  }
}

function renderCatalog({ categories, services, options }) {
  const container = document.querySelector('#public-catalog');
  option.replaceChildren(new Option('Selecione um serviço', ''));
  for (const category of categories) {
    const group = element('div', undefined, 'catalog-group');
    group.append(element('h3', categoryLabel(category, categories)));
    for (const service of services.filter(({ category_id }) => category_id === category.id)) {
      const variations = options.filter(({ service_id }) => service_id === service.id);
      if (!variations.length) continue;
      group.append(element('h4', service.name));
      for (const variation of variations) {
        const label = variation.name === 'Sessão' ? service.name : `${service.name} · ${variation.name}`;
        option.add(new Option(label, variation.id));
        const button = element('button', 'Escolher', 'secondary');
        button.type = 'button';
        button.setAttribute('aria-label', `Escolher ${label}`);
        button.addEventListener('click', () => {
          if (submitting) return;
          option.value = variation.id;
          option.focus();
          updateSelection();
        });
        const line = element('div', undefined, 'catalog-option');
        line.append(element('span', `${variation.name} · ${variation.duration} min · ${priceLabel(variation)}`), button);
        group.append(line);
      }
    }
    if (group.children.length > 1) container.append(group);
  }
  if (!container.children.length) container.textContent = 'Ainda não há serviços disponíveis para agendamento.';
}

function updateSelection() {
  result.hidden = true;
  showError();
  return loadSlots();
}

option.addEventListener('change', updateSelection);
date.addEventListener('change', updateSelection);
slot.addEventListener('change', () => {
  submit.disabled = slot.value === '' || submitting;
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const selected = slots[slot.value];
  if (!selected || submitting) return;
  const data = {
    ...Object.fromEntries(new FormData(form)),
    staffId: selected.staff_id,
    startsAt: selected.starts_at,
  };
  submitting = true;
  option.disabled = date.disabled = slot.disabled = submit.disabled = true;
  result.hidden = true;
  showError();
  try {
    const confirmation = await api(`${base}/bookings`, 'POST', data);
    const time = timeLabel(confirmation.startsAt, timeZone);
    const displayDate = data.date.split('-').reverse().join('/');
    result.replaceChildren(
      element('strong', `Agendamento confirmado para ${displayDate} às ${time}.`),
      element('p', `Profissional: ${selected.display_name}. Para remarcar ou cancelar, fale com a clínica.`),
    );
    result.hidden = false;
    form.elements.patientName.value = '';
    form.elements.phone.value = '';
  } catch (error) {
    showError(error.status ? error.message : 'Não foi possível confirmar. Confira com a clínica antes de repetir a reserva.');
  } finally {
    submitting = false;
    option.disabled = date.disabled = false;
    await loadSlots();
  }
});

try {
  const catalog = await api(`${base}/catalog`);
  document.querySelector('#booking-clinic').textContent = catalog.name;
  document.title = `${catalog.name} · Agendamento`;
  timeZone = catalog.timeZone;
  date.value = date.min = catalog.today;
  date.max = catalog.lastDay;
  renderCatalog(catalog);
  document.querySelector('#booking-content').hidden = false;
  await loadSlots();
} catch (error) {
  document.querySelector('#booking-clinic').textContent = 'Agendamento';
  showError(error.status ? error.message : 'Não foi possível abrir o agendamento.');
}
