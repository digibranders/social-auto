/** Which screen is showing, kept in the address (#/clients, #/client/brandbasket/posts or /cost, #/calendar, #/help/facebook). */
export type GuideKey = 'facebook' | 'instagram' | 'google' | 'linkedin';
export const GUIDE_KEYS: readonly GuideKey[] = ['facebook', 'instagram', 'google', 'linkedin'];
export type ClientTab = 'channels' | 'posts' | 'cost';
const CLIENT_TABS: readonly ClientTab[] = ['channels', 'posts', 'cost'];

export type Route =
  | { page: 'clients' }
  | { page: 'client'; brand: string; tab: ClientTab }
  | { page: 'calendar' }
  | { page: 'review' }
  | { page: 'help'; channel: GuideKey };

const BRAND = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function parseRoute(hash: string): Route {
  const [page, a, b] = hash.replace(/^#\/?/, '').split('/');
  if (page === 'calendar') return { page: 'calendar' };
  if (page === 'review') return { page: 'review' };
  if (page === 'client' && a && BRAND.test(a)) return { page: 'client', brand: a, tab: CLIENT_TABS.find((tab) => tab === b) ?? 'channels' };
  if (page === 'help') return { page: 'help', channel: GUIDE_KEYS.find((key) => key === a) ?? 'facebook' };
  return { page: 'clients' };
}

export function routeHash(route: Route): string {
  switch (route.page) {
    case 'clients':
      return '#/clients';
    case 'calendar':
      return '#/calendar';
    case 'review':
      return '#/review';
    case 'client':
      return `#/client/${route.brand}/${route.tab}`;
    case 'help':
      return `#/help/${route.channel}`;
  }
}
