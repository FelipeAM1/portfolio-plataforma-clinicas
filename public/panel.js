import { api } from './client.js';
import { createCare } from './care.js';
import { createClinicTools } from './clinic-tools.js';

const login = document.querySelector('#login');
const panel = document.querySelector('#panel');
const clinicPicker = document.querySelector('#clinic');
const logout = document.querySelector('#logout');
const notice = document.querySelector('#notice');
const list = document.querySelector('#patient-list');
const settings = document.querySelector('#settings');
const clinicName = document.querySelector('#name');
const roles = { owner: 'Proprietária', reception: 'Recepção', professional: 'Profissional' };
let clinics = [];
let panelVersion = 0;

function message(text) {
  notice.textContent = text;
  notice.hidden = !text;
}

const care = createCare(showError);
const showTools = createClinicTools({ message, showError, care, refreshPatients: loadPatients });

function showLogin() {
  panelVersion++;
  clinics = [];
  care.reset();
  void showTools(null);
  list.replaceChildren();
  panel.hidden = true;
  logout.hidden = true;
  login.hidden = false;
}

function showError(error) {
  if (error.status === 401) showLogin();
  message(error.status ? error.message : 'Não foi possível conectar. Tente novamente.');
}

function patientRow(patient, clinic) {
  const row = document.createElement('li');
  const history = document.createElement('button');
  history.className = 'secondary';
  history.type = 'button';
  history.textContent = 'Abrir ficha';
  history.addEventListener('click', () => care.openHistory(clinic, patient.id));
  if (clinic.role === 'professional') {
    row.className = 'record-row';
    row.append(patient.name, history);
    return row;
  }
  const form = document.createElement('form');
  form.className = 'inline-form';
  const input = document.createElement('input');
  input.setAttribute('aria-label', `Nome de ${patient.name}`);
  input.value = patient.name;
  input.required = true;
  input.minLength = 2;
  input.maxLength = 100;
  const save = document.createElement('button');
  save.className = 'secondary';
  save.textContent = 'Salvar';
  form.append(input, save, history);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      const result = await api(`/api/clinics/${clinic.slug}/patients/${patient.id}`, 'PATCH', { name: input.value });
      input.value = result.name;
      input.setAttribute('aria-label', `Nome de ${result.name}`);
      message('Cadastro atualizado.');
    } catch (error) {
      showError(error);
    } finally {
      save.disabled = false;
    }
  });
  row.append(form);
  return row;
}

async function showClinic() {
  panelVersion++;
  care.reset();
  const clinic = clinics.find(({ slug }) => slug === clinicPicker.value);
  list.replaceChildren();
  settings.hidden = clinic?.role !== 'owner';
  document.querySelector('#patients').hidden = !clinic;
  if (!clinic) {
    await showTools(null);
    document.querySelector('#clinic-name').textContent = 'Nenhuma clínica disponível';
    document.querySelector('#profile').textContent = 'Seu vínculo precisa estar ativo.';
    return;
  }
  document.querySelector('#clinic-name').textContent = clinic.name;
  document.querySelector('#profile').textContent = roles[clinic.role];
  document.querySelector('#patient-scope').textContent = clinic.role === 'professional'
    ? 'Cadastros atribuídos a você.'
    : 'Cadastros desta clínica.';
  clinicName.value = clinic.name;
  await Promise.all([loadPatients(clinic), showTools(clinic)]);
}

async function loadPatients(clinic) {
  const version = panelVersion;
  try {
    const { patients } = await api(`/api/clinics/${clinic.slug}/patients`);
    if (version !== panelVersion) return;
    list.replaceChildren();
    for (const patient of patients) list.append(patientRow(patient, clinic));
    if (!patients.length) {
      const empty = document.createElement('li');
      empty.textContent = 'Nenhum cadastro disponível.';
      list.append(empty);
    }
  } catch (error) {
    if (version === panelVersion) showError(error);
  }
}

async function loadPanel() {
  const account = await api('/api/me');
  clinics = account.clinics;
  clinicPicker.replaceChildren(...clinics.map((clinic) => new Option(clinic.name, clinic.slug)));
  document.querySelector('#clinic-choice').hidden = clinics.length < 2;
  login.hidden = true;
  panel.hidden = false;
  logout.hidden = false;
  await showClinic();
}

clinicPicker.addEventListener('change', showClinic);

document.querySelector('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button');
  button.disabled = true;
  message('');
  try {
    await api('/api/login', 'POST', Object.fromEntries(new FormData(form)));
    form.reset();
    await loadPanel();
  } catch (error) {
    showError(error);
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#clinic-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  const clinic = clinics.find(({ slug }) => slug === clinicPicker.value);
  button.disabled = true;
  try {
    const result = await api(`/api/clinics/${clinic.slug}`, 'PATCH', { name: clinicName.value });
    clinic.name = result.name;
    for (const option of clinicPicker.options) {
      if (option.value === clinic.slug) option.textContent = result.name;
    }
    await showClinic();
    message('Nome da clínica atualizado.');
  } catch (error) {
    showError(error);
  } finally {
    button.disabled = false;
  }
});

logout.addEventListener('click', async () => {
  logout.disabled = true;
  try {
    await api('/api/logout', 'POST');
    showLogin();
    message('Você saiu da conta.');
  } catch (error) {
    showError(error);
  } finally {
    logout.disabled = false;
  }
});

try {
  await loadPanel();
} catch (error) {
  if (error.status !== 401) showError(error);
}
