/** Instagram Auto-DM rules panel for a single client. */
import type { ClientSummary } from './clients.ts';
import { button, h, statusMark } from './ui.ts';

interface AutoDmRuleView {
  id: string;
  brand: string;
  keyword: string;
  message: string;
  mediaId?: string;
  requireFollow?: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', ...init });
  if (response.status === 401) {
    location.replace('/login');
    throw new Error('Not signed in');
  }
  const body = (await response.json().catch(() => null)) as (T & { error?: unknown }) | null;
  if (!response.ok) {
    throw new Error(typeof body?.error === 'string' ? body.error : `Request failed (${response.status})`);
  }
  return (body ?? {}) as T;
}

export function autoDmPanel(client: ClientSummary): HTMLElement {
  const igChannel = client.channels.find((c) => c.platform === 'instagram');
  const statusEl = h('p', { class: 'muted' });
  const listEl = h('div', { class: 'post-list' }, h('p', { class: 'muted' }, 'Loading Auto-DM rules…'));

  const keywordInput = h('input', {
    class: 'link-field',
    type: 'text',
    placeholder: 'e.g. LINK, PRICE, INFO',
    maxlength: '120',
    'aria-label': 'Trigger keywords',
  }) as HTMLInputElement;

  const scopeSelect = h(
    'select',
    { class: 'link-field', 'aria-label': 'Apply rule to' },
    h('option', { value: 'all' }, 'All posts & reels'),
    h('option', { value: 'post' }, 'Specific post / reel only'),
  ) as HTMLSelectElement;

  const mediaIdInput = h('input', {
    class: 'link-field',
    type: 'text',
    placeholder: 'Enter Instagram Post / Reel Media ID (numeric)',
    'aria-label': 'Specific post ID',
  }) as HTMLInputElement;

  const mediaIdRow = h('label', { class: 'label', hidden: '' }, 'Post / Reel Media ID', mediaIdInput);
  scopeSelect.addEventListener('change', () => {
    const isPost = scopeSelect.value === 'post';
    mediaIdRow.hidden = !isPost;
    if (!isPost) mediaIdInput.value = '';
  });

  const messageInput = h('textarea', {
    class: 'link-field',
    rows: '3',
    placeholder: 'DM text + link to send automatically (e.g. Here is the link: https://...)',
    maxlength: '1000',
    'aria-label': 'DM message',
  }) as HTMLTextAreaElement;

  const requireFollowInput = h('input', {
    type: 'checkbox',
    'aria-label': 'Require follow before sending link',
  }) as HTMLInputElement;

  const setStatus = (text: string, isError = false): void => {
    statusEl.textContent = text;
    statusEl.classList.toggle('bad-text', isError);
    statusEl.classList.toggle('muted', !isError);
  };

  const renderRules = (rules: AutoDmRuleView[]): void => {
    if (rules.length === 0) {
      listEl.replaceChildren(h('p', { class: 'empty' }, 'No Auto-DM rules yet. Add one above to reply to Instagram comments automatically.'));
      return;
    }
    listEl.replaceChildren(
      ...rules.map((rule) => {
        const toggleBtn = button(rule.enabled ? 'Pause' : 'Enable', 'btn', () => {
          toggleBtn.disabled = true;
          void apiJson(`/api/autodm`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: rule.id, enabled: !rule.enabled }),
          })
            .then(() => refresh())
            .catch((err) => {
              setStatus(err instanceof Error ? err.message : String(err), true);
              toggleBtn.disabled = false;
            });
        });

        const deleteBtn = button('Delete', 'btn btn-quiet btn-danger', () => {
          deleteBtn.disabled = true;
          void apiJson(`/api/autodm?id=${encodeURIComponent(rule.id)}`, { method: 'DELETE' })
            .then(() => refresh())
            .catch((err) => {
              setStatus(err instanceof Error ? err.message : String(err), true);
              deleteBtn.disabled = false;
            });
        });

        return h(
          'div',
          { class: 'channel-row' },
          h(
            'div',
            { class: 'channel-meta' },
            h('b', {}, `Keyword: ${rule.keyword}`, rule.mediaId ? ` · Post ${rule.mediaId}` : ' · All posts', rule.requireFollow ? ' · Follow-gated' : ''),
            h('span', {}, rule.message),
            h('span', { class: 'status-line muted' }, statusMark(rule.enabled), rule.enabled ? 'Active' : 'Paused'),
          ),
          h('div', { class: 'actions' }, toggleBtn, deleteBtn),
        );
      }),
    );
  };

  const refresh = async (): Promise<void> => {
    try {
      const data = await apiJson<{ rules: AutoDmRuleView[] }>(`/api/autodm?brand=${encodeURIComponent(client.brand)}`);
      renderRules(data.rules ?? []);
    } catch (err) {
      listEl.replaceChildren(h('p', { class: 'bad-text' }, err instanceof Error ? err.message : String(err)));
    }
  };

  const addBtn = button('Add Auto-DM rule', 'btn btn-primary', () => {
    const specificPostId = scopeSelect.value === 'post' ? mediaIdInput.value.trim() : '';
    if (scopeSelect.value === 'post' && !specificPostId) {
      setStatus('Please enter the Instagram Post / Reel Media ID, or switch to "All posts & reels".', true);
      return;
    }
    addBtn.disabled = true;
    setStatus('Saving rule…');
    void apiJson(`/api/autodm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        brand: client.brand,
        keyword: keywordInput.value,
        message: messageInput.value,
        requireFollow: requireFollowInput.checked,
        ...(specificPostId ? { mediaId: specificPostId } : {}),
      }),
    })
      .then(() => {
        keywordInput.value = '';
        messageInput.value = '';
        scopeSelect.value = 'all';
        mediaIdInput.value = '';
        mediaIdRow.hidden = true;
        requireFollowInput.checked = false;
        setStatus('Auto-DM rule saved.');
        return refresh();
      })
      .catch((err) => {
        setStatus(err instanceof Error ? err.message : String(err), true);
      })
      .finally(() => {
        addBtn.disabled = false;
      });
  });

  void refresh();

  return h(
    'div',
    { class: 'panel-card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Instagram Auto-DM'), h('span', { class: 'muted' }, igChannel ? `Connected: @${igChannel.account ?? ''}` : 'Instagram not connected')),
    igChannel
      ? h('p', { class: 'muted' }, 'When someone comments a matching keyword on Instagram, they receive this DM automatically (requires the account to be connected with messaging permissions).')
      : h('p', { class: 'bad-text' }, 'Connect an Instagram Business or Creator account on the Channels tab before Auto-DM can send replies.'),
    h(
      'div',
      { class: 'website-card' },
      h('label', { class: 'label' }, 'Apply to', scopeSelect),
      mediaIdRow,
      h('label', { class: 'label' }, 'Trigger keyword(s) (comma-separated)', keywordInput),
      h('label', { class: 'label' }, 'DM message & link', messageInput),
      h('label', { class: 'status-line' }, requireFollowInput, 'Require follow before sending link (2-step button)'),
      h('div', { class: 'actions' }, addBtn),
      statusEl,
    ),
    listEl,
  );
}
