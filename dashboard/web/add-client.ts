import { brandLabel } from './calendar.ts';
import { button, h } from './ui.ts';

/** What the Add client window needs from the page. */
export interface AddClientDeps {
  /** Resolves to an explanation when the client could not be added. */
  submit(name: string, website: string): Promise<string | null>;
  close(): void;
}

/** The slug the server will make from a name, to show what the client will be called. */
export function previewLabel(name: string): string {
  return brandLabel(
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, ''),
  );
}

export function addClientForm(deps: AddClientDeps): HTMLElement {
  const input = h('input', { id: 'client-name', type: 'text', class: 'text-input', 'aria-label': 'Client name', maxlength: '60', autocomplete: 'off', placeholder: 'e.g. Brand Basket' });
  const site = h('input', { id: 'client-website', type: 'text', class: 'text-input', 'aria-label': 'Client website', maxlength: '200', autocomplete: 'off', inputmode: 'url', placeholder: 'e.g. brandbasket.in' });
  const shown = h('p', { class: 'muted' });
  input.addEventListener('input', () => {
    const label = previewLabel(input.value);
    shown.textContent = label ? `It will appear as “${label}”.` : '';
  });
  const message = h('p', { class: 'form-message', role: 'status' });
  const save = button('Add client', 'btn btn-primary', () => {
    if (!previewLabel(input.value)) {
      message.textContent = 'Write the client’s name.';
      message.classList.add('is-error');
      return;
    }
    save.disabled = true;
    message.textContent = 'Saving…';
    message.classList.remove('is-error');
    void deps.submit(input.value, site.value.trim()).then((problem) => {
      if (!problem) return;
      message.textContent = problem;
      message.classList.add('is-error');
      save.disabled = false;
    });
  });
  for (const field of [input, site]) {
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') save.click();
    });
  }
  return h(
    'div',
    { class: 'dialog-inner' },
    h('div', { class: 'dialog-head' }, h('h2', {}, 'Add a client'), button('Close', 'btn btn-quiet', deps.close)),
    h('label', { class: 'label', for: 'client-name' }, 'Client name'),
    input,
    shown,
    h('label', { class: 'label', for: 'client-website' }, 'Website (optional)'),
    site,
    h('p', { class: 'muted' }, 'Posts are planned from this site. You can add or change it later on the client’s page.'),
    h('p', { class: 'muted' }, 'This makes the client’s folder so you can connect their channels and write posts by hand.'),
    h('div', { class: 'actions' }, save, button('Cancel', 'btn btn-quiet', deps.close)),
    message,
  );
}
