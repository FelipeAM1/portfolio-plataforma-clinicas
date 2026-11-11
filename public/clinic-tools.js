import { api, categoryLabel, element, priceLabel, timeLabel } from './client.js';

const byId = (id) => document.getElementById(id);
const categoryForm = byId('categories-form');
const serviceForm = byId('services-form');
const optionForm = byId('options-form');
const hoursForm = byId('hours-form');
const agendaDate = byId('agenda-date');
const weekdays = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo'];

function choices(select, placeholder, records, label = ({ name }) => name) {
  const selected = select.value;
  select.replaceChildren(new Option(placeholder, ''), ...records.map((record) => new Option(label(record), record.id)));
  if (records.some(({ id }) => id === selected)) select.value = selected;
}

function action(text, run, className = 'secondary') {
  const button = element('button', text, className);
  button.type = 'button';
  button.addEventListener('click', () => run(button));
  return button;
}

export function createClinicTools({ message, showError, care, refreshPatients }) {
  let clinic;
  let catalog;
  let hours = [];
  let agendaVersion = 0;
  const path = (section) => `/api/clinics/${clinic.slug}/${section}`;

  function fillCategory() {
    const fields = categoryForm.elements;
    const category = catalog.categories.find(({ id }) => id === fields.id.value);
    fields.name.value = category?.name ?? '';
    fields.parentId.value = category?.parent_id ?? '';
    fields.parentId.disabled = Boolean(category);
    byId('category-parent-field').hidden = Boolean(category);
  }

  function fillService() {
    const fields = serviceForm.elements;
    const service = catalog.services.find(({ id }) => id === fields.id.value);
    fields.name.value = service?.name ?? '';
    fields.categoryId.value = service?.category_id ?? '';
    fields.active.checked = service?.active ?? true;
    const assigned = new Set(catalog.assignments.filter(({ service_id }) => service_id === service?.id)
      .map(({ staff_id }) => staff_id));
    byId('service-staff').replaceChildren(...catalog.staff.map((staff) => {
      const label = element('label', undefined, 'check');
      const input = element('input');
      input.type = 'checkbox';
      input.name = 'staffIds';
      input.value = staff.id;
      input.checked = assigned.has(staff.id);
      label.append(input, staff.display_name);
      return label;
    }));
  }

  function showPriceFields() {
    const fields = optionForm.elements;
    const hasPrice = fields.priceKind.value !== 'quote';
    const hasUnit = fields.priceKind.value === 'unit';
    byId('price-field').hidden = !hasPrice;
    byId('unit-field').hidden = !hasUnit;
    fields.price.disabled = !hasPrice;
    fields.priceUnit.disabled = !hasUnit;
    fields.priceUnit.required = hasUnit;
  }

  function fillOption() {
    const fields = optionForm.elements;
    const option = catalog.options.find(({ id }) => id === fields.id.value);
    fields.serviceId.value = option?.service_id ?? '';
    fields.serviceId.disabled = Boolean(option);
    fields.name.value = option?.name ?? 'Sessão';
    fields.duration.value = option?.duration ?? '';
    fields.priceKind.value = option?.price_kind ?? 'fixed';
    fields.price.value = option?.price_cents == null ? '' : (option.price_cents / 100).toFixed(2);
    fields.priceUnit.value = option?.price_unit ?? '';
    fields.active.checked = option?.active ?? true;
    showPriceFields();
  }

  function renderCatalog() {
    const { categories, services, options, staff } = catalog;
    const label = (category) => categoryLabel(category, categories);
    const serviceName = (id) => services.find((service) => service.id === id)?.name;
    const content = byId('clinic-catalog');
    content.replaceChildren();
    for (const category of categories) {
      const group = element('div', undefined, 'catalog-group');
      group.append(element('h3', label(category)));
      for (const service of services.filter(({ category_id }) => category_id === category.id)) {
        const name = service.active ? service.name : `${service.name} · Oculto`;
        group.append(element('h4', name));
        const variations = options.filter(({ service_id }) => service_id === service.id);
        for (const option of variations) {
          const visibility = option.active ? '' : ' · Oculta';
          group.append(element('p', `${option.name} · ${option.duration} min · ${priceLabel(option)}${visibility}`));
        }
        if (!variations.length) group.append(element('p', 'Ainda sem opções de agendamento.'));
      }
      content.append(group);
    }
    if (!categories.length) content.append(element('p', 'Nenhuma categoria cadastrada.'));
    if (clinic.role !== 'owner') return;

    choices(categoryForm.elements.id, 'Nova categoria', categories, label);
    choices(categoryForm.elements.parentId, 'Nenhuma (categoria principal)', categories.filter((item) => !item.parent_id));
    choices(serviceForm.elements.id, 'Novo serviço', services);
    choices(serviceForm.elements.categoryId, 'Selecione uma categoria', categories, label);
    choices(optionForm.elements.id, 'Nova opção', options, (item) => `${serviceName(item.service_id)} · ${item.name}`);
    choices(optionForm.elements.serviceId, 'Selecione um serviço', services);
    choices(hoursForm.elements.staffId, 'Selecione uma profissional', staff, ({ display_name }) => display_name);
    if (!hoursForm.elements.staffId.value && staff.length) hoursForm.elements.staffId.value = staff[0].id;
    fillCategory();
    fillService();
    fillOption();
    renderHours();
  }

  async function loadCatalog() {
    const current = clinic;
    const response = await api(path('catalog'));
    if (clinic !== current) return;
    catalog = response;
    renderCatalog();
    byId('catalog-editor').hidden = clinic.role !== 'owner';
  }

  async function mutate(button, run, refresh, success) {
    const current = clinic;
    button.disabled = true;
    try {
      await run();
      if (clinic !== current) return;
      await refresh();
      if (clinic === current) message(success);
    } catch (error) {
      if (clinic === current) showError(error);
    } finally {
      button.disabled = false;
    }
  }

  function renderHours() {
    const content = byId('hours-list');
    const staffId = hoursForm.elements.staffId.value;
    content.replaceChildren();
    for (const item of hours.filter(({ staff_id }) => staff_id === staffId)) {
      const row = element('li', undefined, 'record-row');
      row.append(element('span', `${weekdays[item.weekday - 1]} · ${item.opens} às ${item.closes}`),
        action('Remover', (button) => mutate(button, () => api(path(`hours/${item.id}`), 'DELETE'), loadHours, 'Intervalo removido.')));
      content.append(row);
    }
    if (!content.children.length) content.append(element('li', 'Nenhum intervalo cadastrado para esta profissional.'));
  }

  async function loadHours() {
    const current = clinic;
    const response = await api(path('hours'));
    if (clinic !== current) return;
    hours = response.hours;
    renderHours();
  }

  async function loadAgenda() {
    const version = ++agendaVersion;
    const current = clinic;
    const list = byId('booking-list');
    const query = agendaDate.value ? `?date=${encodeURIComponent(agendaDate.value)}` : '';
    list.replaceChildren(element('li', 'Buscando atendimentos…'));
    try {
      const { date, timeZone, bookings } = await api(path(`agenda${query}`));
      if (clinic !== current || agendaVersion !== version) return;
      agendaDate.value = date;
      list.replaceChildren();
      for (const booking of bookings) {
        const row = element('li', undefined, 'record-row');
        const info = element('div');
        const start = timeLabel(booking.starts_at, timeZone);
        const end = timeLabel(booking.ends_at, timeZone);
        const status = booking.recorded ? 'Atendimento registrado' : booking.status === 'confirmed' ? 'Confirmado' : 'Cancelado';
        info.append(element('strong', `${start}–${end} · ${booking.service_name} · ${booking.option_name}`),
          element('p', `${booking.patient_name} · ${booking.phone}`),
          element('p', `${booking.display_name} · ${status}`, 'muted'));
        row.append(info);
        const actions = element('div', undefined, 'record-actions');
        const managesBookings = clinic.role !== 'professional';
        if (booking.patient_id) {
          actions.append(action('Abrir ficha', () => care.openHistory(current, booking.patient_id)));
        }
        if (booking.status === 'confirmed' && !booking.recorded) {
          if (!booking.patient_id && managesBookings) {
            actions.append(action('Vincular paciente', () => care.openLink(current, booking, async () => {
              if (clinic === current) await Promise.all([loadAgenda(), refreshPatients(current)]);
            })));
          }
          if (booking.patient_id && booking.assigned_to_me) {
            actions.append(action('Registrar atendimento', () => care.openEncounter(current, booking, async () => {
              if (clinic === current) await loadAgenda();
            }), ''));
          }
        }
        if (booking.upcoming && booking.status === 'confirmed' && !booking.recorded && managesBookings) {
          const cancel = action('Cancelar reserva', (button) => {
            if (window.confirm('Cancelar esta reserva e liberar o horário?')) {
              return mutate(button, () => api(path(`bookings/${booking.id}`), 'DELETE'), loadAgenda, 'Reserva cancelada.');
            }
          });
          actions.append(cancel);
        }
        if (actions.children.length) row.append(actions);
        list.append(row);
      }
      if (!bookings.length) list.append(element('li', 'Nenhum atendimento nesta data.'));
    } catch (error) {
      if (clinic === current && agendaVersion === version) {
        list.replaceChildren(element('li', 'A agenda não pôde ser carregada.'));
        showError(error);
      }
    }
  }

  const catalogForms = [
    [categoryForm, 'categories', fillCategory],
    [serviceForm, 'services', fillService],
    [optionForm, 'options', fillOption],
  ];
  for (const [form, section, fill] of catalogForms) {
    form.elements.id.addEventListener('change', fill);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const values = new FormData(form);
      const { id, name, categoryId, parentId, serviceId, priceKind, price, priceUnit, duration } = Object.fromEntries(values);
      let data = { name, parentId };
      if (section === 'services') data = { name, categoryId, staffIds: values.getAll('staffIds'), active: values.has('active') };
      if (section === 'options') data = {
        name, serviceId, priceKind, priceUnit, priceCents: price ? Math.round(Number(price) * 100) : null,
        duration: Number(duration), active: values.has('active'),
      };
      return mutate(form.querySelector('button'),
        () => api(path(id ? `${section}/${id}` : section), id ? 'PATCH' : 'POST', data),
        loadCatalog, 'Catálogo atualizado.');
    });
  }

  optionForm.elements.priceKind.addEventListener('change', showPriceFields);
  agendaDate.addEventListener('change', loadAgenda);
  hoursForm.elements.staffId.addEventListener('change', renderHours);
  hoursForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(hoursForm));
    data.weekday = Number(data.weekday);
    return mutate(hoursForm.querySelector('button'), () => api(path('hours'), 'POST', data), loadHours, 'Intervalo adicionado.');
  });

  return async function showTools(current) {
    clinic = current;
    catalog = null;
    hours = [];
    const owner = clinic?.role === 'owner';
    for (const id of ['agenda', 'catalog', 'clinic-nav']) byId(id).hidden = !clinic;
    byId('hours-editor').hidden = !owner;
    byId('catalog-editor').hidden = true;
    byId('clinic-catalog').replaceChildren();
    byId('booking-list').replaceChildren();
    byId('hours-list').replaceChildren();
    if (!clinic) return;
    agendaDate.value = '';
    byId('booking-link').href = `/clinica/${clinic.slug}`;
    try {
      await Promise.all([loadCatalog(), loadAgenda(), ...(owner ? [loadHours()] : [])]);
    } catch (error) {
      if (clinic === current) showError(error);
    }
  };
}
