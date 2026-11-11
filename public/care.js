import { api, element } from './client.js';

const dialog = document.querySelector('#care-dialog');
const title = document.querySelector('#care-title');
const notice = document.querySelector('#care-notice');
const linkForm = document.querySelector('#link-patient-form');
const encounterForm = document.querySelector('#encounter-form');
const history = document.querySelector('#care-history');
const dateTime = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Bahia',
});

function showNotice(text = '') {
  notice.textContent = text;
  notice.hidden = !text;
}

export function createCare(showError) {
  let state;

  function reset() {
    state = null;
    linkForm.hidden = encounterForm.hidden = history.hidden = true;
    linkForm.reset();
    encounterForm.reset();
    history.replaceChildren();
    showNotice();
    if (dialog.open) dialog.close();
  }

  dialog.addEventListener('close', () => {
    if (!dialog.open) reset();
  });

  function open(next, heading) {
    state = next;
    title.textContent = heading;
    linkForm.hidden = encounterForm.hidden = history.hidden = true;
    history.replaceChildren();
    showNotice();
    if (!dialog.open) dialog.showModal();
  }

  function report(error) {
    if (error.status === 401) showError(error);
    else showNotice(error.status ? error.message : 'Não foi possível conectar. Tente novamente.');
  }

  async function openHistory(clinic, patientId, saved = false) {
    const current = { clinic };
    open(current, 'Ficha da paciente');
    showNotice('Carregando histórico…');
    try {
      const result = await api(`/api/clinics/${clinic.slug}/patient-history/${patientId}`);
      if (state !== current) return;
      title.textContent = `Ficha de ${result.patient.name}`;
      history.hidden = false;
      for (const visit of result.encounters) {
        const card = element('article', undefined, 'care-visit');
        card.append(element('h3', visit.procedure));
        const when = dateTime.format(new Date(visit.recorded_at));
        card.append(element('p', `${visit.display_name} · Registrado em ${when}`, 'muted'));
        for (const [label, value] of [
          ['Queixa relatada', visit.complaint], ['Alergias relatadas', visit.allergies],
          ['Intercorrências e observações', visit.notes],
        ]) {
          if (!value) continue;
          const paragraph = element('p');
          paragraph.append(element('strong', label), document.createElement('br'), value);
          card.append(paragraph);
        }
        history.append(card);
      }
      if (!result.encounters.length) history.append(element('p', 'Ainda não há atendimentos registrados.'));
      showNotice(saved ? 'Atendimento registrado.' : '');
    } catch (error) {
      if (state === current) report(error);
    }
  }

  async function openLink(clinic, booking, refresh) {
    const current = { clinic, booking, refresh };
    open(current, 'Vincular paciente à reserva');
    showNotice('Buscando cadastros…');
    try {
      const { patients, patientId } = await api(`/api/clinics/${clinic.slug}/booking-patients/${booking.id}`);
      if (state !== current) return;
      if (patientId) {
        reset();
        await refresh();
        return;
      }
      document.querySelector('#link-booking-name').textContent = booking.patient_name;
      linkForm.elements.patientId.replaceChildren(new Option('Selecione um cadastro', ''),
        ...patients.map(({ name, id }) => new Option(name, id)));
      document.querySelector('#link-existing').disabled = !patients.length;
      linkForm.hidden = false;
      showNotice();
    } catch (error) {
      if (state === current) report(error);
    }
  }

  function openEncounter(clinic, booking, refresh) {
    open({ clinic, booking, refresh }, 'Registrar atendimento');
    encounterForm.reset();
    encounterForm.elements.procedure.value = booking.service_name;
    document.querySelector('#encounter-booking-name').textContent = booking.patient_name;
    encounterForm.hidden = false;
    encounterForm.elements.procedure.focus();
  }

  async function submit(event, section, data, onSaved) {
    event.preventDefault();
    const current = state;
    const button = event.submitter ?? event.currentTarget.querySelector('button');
    if (!current || current.saving) return;
    current.saving = true;
    button.disabled = true;
    showNotice();
    try {
      const { clinic, booking } = current;
      const result = await api(`/api/clinics/${clinic.slug}/${section}/${booking.id}`, 'POST', data);
      await current.refresh();
      if (state === current) await onSaved(clinic, result.patientId);
    } catch (error) {
      if (state === current) report(error);
    } finally {
      current.saving = false;
      button.disabled = false;
    }
  }

  linkForm.addEventListener('submit', (event) => {
    const patientId = event.submitter?.value === 'create' ? null : linkForm.elements.patientId.value;
    return submit(event, 'booking-patients', { patientId }, () => {
      linkForm.hidden = true;
      showNotice('Cadastro vinculado à reserva.');
    });
  });
  encounterForm.addEventListener('submit', (event) => {
    return submit(event, 'encounters', Object.fromEntries(new FormData(encounterForm)),
      (clinic, patientId) => openHistory(clinic, patientId, true));
  });

  return { openHistory, openLink, openEncounter, reset };
}
