/** The sign-in page. */
import { applyStoredTheme } from './theme.ts';

applyStoredTheme();

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id} in the page`);
  return element as T;
}

const form = required<HTMLFormElement>('login-form');
const password = required<HTMLInputElement>('password');
const submit = required<HTMLButtonElement>('submit');
const message = required<HTMLElement>('message');

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void signIn();
});

async function signIn(): Promise<void> {
  submit.disabled = true;
  message.textContent = '';
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ password: password.value }),
    });
    if (response.ok) {
      location.replace('/');
      return;
    }
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    message.textContent = typeof body?.error === 'string' ? body.error : 'Could not sign in';
    password.select();
  } catch {
    message.textContent = 'Could not reach the server';
  } finally {
    submit.disabled = false;
  }
}
