import { captionProblem, captionStats, MAX_CAPTION_LENGTH, MAX_HASHTAGS } from './calendar.ts';
import { clientOption, dropdown } from './dropdown.ts';
import { brandMark, button, h, platformLabel } from './ui.ts';
import type { ChannelHealth } from '../shared/status.ts';

const MAX_PICTURE_BYTES = 4 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

/** What the form needs from the page: the clients and channels, and the call that saves a post. */
export interface NewPostDeps {
  clients: Array<{ brand: string; label: string }>;
  channels: ChannelHealth[];
  /** Resolves to an explanation when the post could not be saved. */
  submit(post: { brand: string; day: string; caption: string; picture: File; channels: string[] }): Promise<string | null>;
  close(): void;
}

/** The id a channel goes by in a post: "instagram" for the shared Instagram account, else the channel's own id. */
export const postChannelId = (channel: ChannelHealth): string | null => (channel.platform === 'instagram' ? 'instagram' : channel.id);

/** Tomorrow as YYYY-MM-DD in the person's own calendar: the daily run is in the morning, so today is too late. */
export function earliestDay(now: number): string {
  const d = new Date(now + DAY_MS);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The New post window: pick the client, the channels, the day, a picture and the words. */
export function newPostForm(brand: string | null, preselect: string | null, deps: NewPostDeps): HTMLElement {
  const who = dropdown(deps.clients.map((c) => clientOption(c.brand, c.label)), brand ?? deps.clients[0]?.brand ?? '', 'Client');

  const boxes = h('div', { class: 'channel-checks' });
  const ticked = new Set<string>(preselect ? [preselect] : []);
  const drawChannels = (): void => {
    const mine = deps.channels.filter((c) => c.brands.includes(who.value) && postChannelId(c) !== null);
    boxes.replaceChildren(
      ...(mine.length === 0
        ? [h('p', { class: 'muted' }, 'This client has no connected channel yet. Add one first.')]
        : mine.map((channel) => {
            const id = postChannelId(channel) as string;
            const input = h('input', { type: 'checkbox', value: id });
            input.checked = ticked.has(id);
            input.addEventListener('change', () => (input.checked ? ticked.add(id) : ticked.delete(id)));
            return h('label', { class: 'check-row' }, input, h('span', { class: 'mark' }, brandMark(channel.platform)), h('span', {}, `${platformLabel(channel.platform)}${channel.account ? ` · ${channel.account}` : ''}`));
          })),
    );
  };
  who.addEventListener('change', () => {
    ticked.clear();
    drawChannels();
  });
  drawChannels();

  const day = h('input', { type: 'date', class: 'btn', 'aria-label': 'Day', min: earliestDay(Date.now()) });
  const picture = h('input', { type: 'file', accept: 'image/jpeg', class: 'visually-hidden', id: 'new-picture' });
  const pictureName = h('span', { class: 'muted' }, 'No picture chosen');
  const pick = button('Choose picture', 'btn', () => picture.click());
  picture.addEventListener('change', () => {
    pictureName.textContent = picture.files?.[0]?.name ?? 'No picture chosen';
  });

  const area = h('textarea', { class: 'caption-input', rows: '8', 'aria-label': 'Caption', maxlength: String(MAX_CAPTION_LENGTH * 2) });
  const count = h('p', { class: 'muted counter' });
  const update = (): void => {
    const { length, hashtags } = captionStats(area.value);
    count.textContent = `${length} / ${MAX_CAPTION_LENGTH} characters · ${hashtags} / ${MAX_HASHTAGS} hashtags`;
    count.classList.toggle('is-error', area.value.trim() !== '' && captionProblem(area.value) !== null);
  };
  area.addEventListener('input', update);
  update();

  const message = h('p', { class: 'form-message', role: 'status' });
  const show = (text: string, isError: boolean): void => {
    message.textContent = text;
    message.classList.toggle('is-error', isError);
  };
  const save = button('Schedule post', 'btn btn-primary', () => {
    const chosen = picture.files?.[0];
    const problem =
      ticked.size === 0 ? 'Choose at least one channel.'
      : !day.value ? 'Choose the day.'
      : !chosen ? 'Choose a picture.'
      : chosen.type !== 'image/jpeg' ? 'The picture must be a JPG.'
      : chosen.size > MAX_PICTURE_BYTES ? 'That picture is over 4 MB. Choose a smaller one.'
      : area.value.trim() === '' ? 'Write the caption.'
      : captionProblem(area.value);
    if (problem || !chosen) return show(problem ?? '', true);
    save.disabled = true;
    show('Saving…', false);
    void deps.submit({ brand: who.value, day: day.value, caption: area.value, picture: chosen, channels: [...ticked] }).then((error) => {
      if (error) {
        show(error, true);
        save.disabled = false;
      }
    });
  });

  return h(
    'div',
    { class: 'dialog-inner' },
    h('div', { class: 'dialog-head' }, h('h2', {}, 'New post'), button('Close', 'btn btn-quiet', deps.close)),
    deps.clients.length > 1 ? h('label', { class: 'picker-client' }, h('span', { class: 'muted' }, 'For client'), who) : null,
    h('h3', { class: 'label' }, 'Post to'),
    boxes,
    h('h3', { class: 'label' }, 'Day'),
    h('div', { class: 'actions' }, day, h('span', { class: 'muted' }, 'Goes out at 10:00 AM that day, with the daily run.')),
    h('h3', { class: 'label' }, 'Picture'),
    h('div', { class: 'actions' }, pick, picture, pictureName),
    h('p', { class: 'muted' }, 'Square JPG, up to 4 MB.'),
    h('h3', { class: 'label' }, 'Caption'),
    area,
    count,
    h('div', { class: 'actions' }, save, button('Cancel', 'btn btn-quiet', deps.close)),
    message,
  );
}
