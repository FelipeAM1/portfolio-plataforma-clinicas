export async function api(path, method = 'GET', data) {
  const options = { method };
  if (data !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(data);
  }
  const response = await fetch(path, options);
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error);
    error.status = response.status;
    throw error;
  }
  return result;
}

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export function priceLabel(option) {
  const amount = brl.format(option.price_cents / 100);
  switch (option.price_kind) {
    case 'quote': return 'Sob consulta';
    case 'from': return `A partir de ${amount}`;
    case 'unit': return `${amount} por ${option.price_unit}`;
    default: return amount;
  }
}

export function timeLabel(date, timeZone) {
  return new Intl.DateTimeFormat('pt-BR', { timeZone, hour: '2-digit', minute: '2-digit' }).format(new Date(date));
}

export function categoryLabel(category, categories) {
  const parent = categories.find(({ id }) => id === category.parent_id);
  return parent ? `${parent.name} / ${category.name}` : category.name;
}

export function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
