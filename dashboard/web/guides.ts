/**
 * The setup guides: the same steps for every client, written so nothing has to be remembered.
 * Each guide has one-time setup, steps per client, a check, and what to do later.
 * The pictures are drawn from the small row descriptions in each step (see help-page.ts).
 */
import type { GuideKey } from './route.ts';

export type Who = 'client' | 'you' | 'system';

export interface ShotRow {
  t: string;
  s?: string;
  /** The thing to click, highlighted. */
  hi: boolean;
  /** A tick box: true ticked, false empty, undefined none. */
  chk?: boolean;
  /** Shows a round picture, like a profile. */
  av: boolean;
}

export interface Shot {
  url: string;
  rows: ShotRow[];
  btn?: string;
  bhi?: boolean;
}

export interface StepImage {
  /** Path under the site, e.g. /help/facebook/create-page.jpg */
  src: string;
  alt: string;
}

export interface Step {
  who: Who;
  t: string;
  d: string;
  /** The drawn picture, shown when there is no real one. */
  shot: Shot;
  /** Real screenshots of the step (blurred and marked up with tools/prepare-shot.py). */
  images?: StepImage[];
}

export interface StepGroup {
  title: string;
  /** Open when the guide is first shown. */
  open: boolean;
  steps: Step[];
}

export interface Guide {
  name: string;
  intro: string;
  groups: StepGroup[];
  problems: Array<[string, string]>;
}

/**
 * A picture row is written as text: "*" highlights it, "[x]" or "[ ]" adds a tick box, "@" adds a round picture,
 * and "|" separates the title from a smaller line under it.
 */
function row(text: string): ShotRow {
  let rest = text;
  let hi = false;
  let av = false;
  let chk: boolean | undefined;
  // The markers may come in any order, e.g. "[x]*Name" or "*[x]Name".
  for (;;) {
    if (rest.startsWith('*')) hi = true;
    else if (rest.startsWith('@')) av = true;
    else if (rest.startsWith('[x]')) chk = true;
    else if (rest.startsWith('[ ]')) chk = false;
    else break;
    rest = rest.slice(rest.startsWith('[') ? 3 : 1);
  }
  const [t = '', s] = rest.split('|');
  return { t, hi, av, ...(s ? { s } : {}), ...(chk !== undefined ? { chk } : {}) };
}

const SH = (url: string, rows: string[], btn?: string, bhi?: number): Shot => ({
  url,
  rows: rows.map(row),
  ...(btn ? { btn } : {}),
  ...(bhi ? { bhi: true } : {}),
});

const ST = (who: Who, t: string, d: string, shot: Shot, images?: string[]): Step => ({
  who,
  t,
  d,
  shot,
  ...(images ? { images: images.map((src, i) => ({ src, alt: `Screenshot of the step "${t}"${images.length > 1 ? `, ${i + 1} of ${images.length}` : ''}` })) } : {}),
});

export const GUIDES: Record<GuideKey, Guide> = {
facebook:{name:'Facebook Page',
 intro:'Posts go to the client’s Facebook Page. The client only gives your agency account access to the Page. They never use our app and never become a developer.',
 groups:[
  {title:'One-time setup (first time only)',open:false,steps:[
   ST('you','Create the Meta app','Go to developers.facebook.com, My Apps, Create app. Choose the Business type and name it.',SH('developers.facebook.com › My Apps',['*Create app|Choose “Business”','Your existing apps'])),
   ST('you','Add the Pages use case','In the app: Use cases, Add use case, choose the one to manage Pages (“Manage everything on your Page”). Open Customize and add three permissions: pages_show_list, pages_manage_posts, pages_read_engagement. “Ready for testing” is fine while the app is unpublished.',SH('Meta app › Use cases › Manage Pages › Customize',['[x]pages_show_list|Ready for testing','[x]*pages_manage_posts|Ready for testing','[x]pages_read_engagement|Ready for testing'])),
   ST('you','Create the login configuration','Left menu: Facebook Login for Business, Configurations, Create configuration. Name it, choose “User access token”, tick the three permissions, create. Copy the Configuration ID (a long number).',SH('Meta app › Facebook Login for Business › Configurations',['*Create configuration','Page posting|Configuration ID: 1147…'])),
   ST('you','Add the return address','Facebook Login for Business, Settings, “Valid OAuth Redirect URIs”: add https://YOUR-DASHBOARD-ADDRESS/api/facebook-callback and save. (Addresses starting with http://localhost are allowed automatically while the app is unpublished.)',SH('Meta app › Facebook Login for Business › Settings',['Client OAuth login|On','*Valid OAuth Redirect URIs|https://…/api/facebook-callback'],'Save changes')),
   ST('you','Keep your account as Administrator','App roles, Roles. Your agency account must be listed as Administrator (or Developer). While the app is unpublished only accounts with a role can connect.',SH('Meta app › App roles › Roles',['*@Your agency account|Administrator'])),
   ST('you','Save the keys on Vercel','Publisher project: FACEBOOK_APP_ID, FACEBOOK_APP_SECRET, CHANNEL_KEY. Dashboard project: FACEBOOK_APP_ID, FACEBOOK_CONFIG_ID. Then redeploy both. Copy and paste straight into the file or Vercel, never into chat.',SH('Vercel › Project › Settings › Environment Variables',['FACEBOOK_APP_ID|Encrypted','*FACEBOOK_APP_SECRET|Encrypted (sensitive)','CHANNEL_KEY|Encrypted (sensitive)'],'Redeploy'))]},
  {title:'For each new client',open:true,steps:[
   ST('client','Make sure they have a Facebook Page','If they have none: Facebook, Pages, Create new Page. When asked, choose “Public page”, not “upgrade your profile” (that would turn their profile into a Page). Give it a name and a category.',SH('facebook.com › Create a Page',['*Public page|A real Facebook Page','Upgrade your existing profile|Do NOT choose this']), ['/help/facebook/create-page.jpg']),
   ST('client','Open Page access','On the Page: Settings, Page setup, Page access.',SH('facebook.com › Page › Settings',['Page setup','*Page access|Invite people to help manage your Page','Page type']), ['/help/facebook/page-access.jpg']),
   ST('client','Give your account access','Under “People with Facebook access” click Add New. A window explains what Facebook access means: click Next. Then search for your agency account by its profile link or numeric ID (names can match other people, so check the picture). Leave “full control” OFF, then click Give access.',SH('facebook.com › Page access › Add new',['*Search: your profile link or ID','@Your agency account|Content, Messages, Community activity, Ads, Insights','[ ]Allow this person to have full control'],'Give access'), ['/help/facebook/add-new.jpg', '/help/facebook/facebook-access.jpg', '/help/facebook/give-access.jpg']),
   ST('you','Accept the invite','Log in to Facebook as your agency account. Pages, Invitations, Accept. Then check that the Page shows under “Pages you manage”. If Invitations is empty, the client probably invited a different person with a similar name: ask them to cancel it and invite again using your link or ID.',SH('facebook.com › Pages › Invitations',['@Client’s Page|invited you to manage this Page'],'Accept',1), ['/help/facebook/invitations.jpg', '/help/facebook/pages-you-manage.jpg']),
   ST('you','Start the connection','Use your own profile (not switched into a Page). Open the dashboard, the client, Channels, Add channel, Facebook.',SH('Dashboard › Client › Channels › Add channel',['Instagram|Business or Creator account','*Facebook Page|A Page you manage','LinkedIn','Google Business']), ['/help/facebook/add-channel.jpg']),
   ST('you','Approve on Facebook','The window says “Continue as …”. If it says you have previously linked the app, click Edit settings, not Continue: Continue keeps the old Pages and leaves the new one out. Make sure it is you (your agency account), choose “Opt in to current Pages only”, tick the client’s Page, then click Continue. Facebook then says the connection was made: click Got it. If it says the popup is too small, make the window wider.',SH('facebook.com › Choose the Pages you want to allow',['[x]Opt in to current Pages only','[x]*Client’s Page','[ ]Another Page'],'Continue'), ['/help/facebook/continue-as.jpg', '/help/facebook/choose-pages.jpg', '/help/facebook/connected.jpg']),
   ST('system','You return to the calendar','A green message says “Facebook connected”, and the Page appears under Channels with a green dot.',SH('Dashboard › Channels',['@Instagram account|Instagram','*@Client’s Page|Facebook · connected']))]},
  {title:'Check that it works',open:true,steps:[
   ST('you','Look at the calendar','Click the Facebook channel on the left. Posts from the connection onward show a Facebook line in their window. Earlier posts are not sent to the Page.',SH('Dashboard › Calendar › Post',['Instagram · Scheduled','*Facebook · Scheduled'])),
   ST('you','Set how often it posts','Client, Channels, Schedule: choose posts a week or exact days and the time. It applies from the next weekly run.',SH('Dashboard › Channels › Schedule',['[x]*3 a week|Mon, Wed, Fri','Time|10:00 IST'],'Save')),
   ST('you','Confirm with the first real post','After the first scheduled time, open the Page and the post’s window: the Facebook line should say Published with a view link. If an alert arrives instead, see “If something goes wrong”.',SH('Page › Posts',['*@Brand post|Published · just now']))]},
  {title:'Later: reconnect, add another Page, disconnect',open:false,steps:[
   ST('you','Reconnect (token problem)','Add channel, Facebook again, same steps 5 and 6. It replaces the old token.',SH('Dashboard › Channels',['*Reconnect Facebook'])),
   ST('you','Another Page for the same client','Repeat “Give your account access” for the new Page, then Add channel, Facebook, and tick the new Page.',SH('Dashboard › Channels',['*Add channel|Facebook'])),
   ST('you','Disconnect','Client, Channels, Disconnect next to the Page. In Facebook you can also remove the app: Settings, Business integrations, remove.',SH('Dashboard › Channels',['*Disconnect|Client’s Page']))]}],
 problems:[['“App not active”','The Facebook account you used has no role in our Meta app. Log in as your agency account.'],['“You don’t have any Pages”','The Page invite is not accepted yet, or the wrong profile accepted it. Check Pages, Invitations.'],['Invitation never arrives','The client invited a different person. Cancel it and invite again with your profile link or ID.'],['“No Pages came back”','You did not tick a Page in the approval window. Connect again and tick it.'],['Facebook shows a blank or “popup too small” page','Make the browser window wider, then try again.'],['Alert: Facebook post failed','Open the channel: if it is red, reconnect. The message names the Page; Instagram is not affected.']]},
instagram:{name:'Instagram',
 intro:'Posts go to the client’s Instagram account. Today the account is added as a tester and you generate its token by hand. After Meta’s app review this becomes one link the client clicks.',
 groups:[
  {title:'One-time setup (first time only)',open:false,steps:[
   ST('you','Add the Instagram use case','In the Meta app: Use cases, Add use case, “Manage messaging & content on Instagram”. Open Customize, then “API setup with Instagram login”.',SH('Meta app › Use cases › Instagram',['*API setup with Instagram login','Business login settings'])),
   ST('you','Add the permissions','Make sure instagram_business_basic and instagram_business_content_publish are added.',SH('Meta app › Instagram › Permissions',['[x]instagram_business_basic','[x]*instagram_business_content_publish'])),
   ST('you','Return address (for the later Connect link)','Business login settings: add the dashboard’s return address when we switch from manual tokens to the Connect link. Not needed for the manual way.',SH('Meta app › Instagram › Business login settings',['*OAuth redirect URIs|add the dashboard address'],'Save')),
   ST('you','Where the token is kept','For each connected account the token and account ID are stored as hidden variables (INSTAGRAM_TOKEN, INSTAGRAM_USER_ID on the first one). Never paste a token in chat.',SH('Vercel › Environment Variables',['INSTAGRAM_TOKEN|Encrypted','*INSTAGRAM_USER_ID|Encrypted']))]},
  {title:'For each new client',open:true,steps:[
   ST('client','Switch to a professional account','Instagram app: Settings, Account type and tools, Switch to professional account, choose Business (or Creator). A linked Facebook Page is not needed.',SH('Instagram › Settings › Account type and tools',['*Switch to professional account','Creator tools and controls'])),
   ST('client','Send you the username','They send you the exact username, for example @clientusername.',SH('Message to you',['*@Our Instagram is @clientusername'])),
   ST('you','Add them as an Instagram Tester','In the Meta app: App roles, Roles, Add People. Choose “Instagram Tester”, type the username, click Add.',SH('Meta app › App roles › Roles',['*Add people','[x]Instagram Tester','@@clientusername'],'Add')),
   ST('client','Accept the tester invite','Instagram app: Settings, Apps and Websites, Tester Invites, Accept. (On the web: instagram.com/accounts/manage_access.) They must be logged in to that exact account.',SH('Instagram › Settings › Apps and Websites › Tester Invites',['@scheduler|invited you to test this app'],'Accept',1)),
   ST('you','Generate the token','Meta app: Instagram API setup, find the account, click Generate token and approve on Instagram’s login. Use a private window if another Instagram is logged in. If Instagram asks to approve the login from a new device, approve it in the Instagram app on the client’s phone.',SH('Meta app › Instagram API setup',['@@clientusername|Instagram account','*Generate token'])),
   ST('you','Save the token','Copy it and save it privately: today as a hidden Vercel variable, later in the dashboard (Add channel, Instagram). Never paste it in chat. Then redeploy.',SH('Vercel › Environment Variables',['*INSTAGRAM_TOKEN|paste, then save'],'Save')),
   ST('system','Green dot','The account appears under Channels with a green dot. Posts go at the scheduled time.',SH('Dashboard › Channels',['*@Client name|Instagram · connected']))]},
  {title:'Check that it works',open:true,steps:[
   ST('you','Dry run','Ask Claude to run a dry run of the daily job on an upcoming post. It prepares the post without publishing it and should say ready.',SH('Result',['*dry-run-ready|post prepared, not published'])),
   ST('you','Watch the first post','After the first scheduled time the post’s window says Published with a view link.',SH('Dashboard › Post',['*Instagram · Published|view'])),
   ST('system','Weekly renewal','Every Monday the token is renewed by itself. If renewal fails you get a push alert and must generate a new token.',SH('Alert',['*Instagram token renewal failed']))]},
  {title:'Later: reconnect or remove',open:false,steps:[
   ST('you','Token revoked or expired','Generate a new token (same steps 5 and 6) and save it. It happens if the client changes their password or removes the app.',SH('Meta app › Instagram API setup',['*Generate token'])),
   ST('you','Remove a client','Delete their token variable, and remove the tester role in App roles.',SH('Meta app › App roles',['*Remove|Instagram Tester']))]}],
 problems:[['“Insufficient developer role”','The tester invite is not accepted, or a different Instagram account is logged in.'],['“Invalid redirect URI” or “Could not add provider”','The return address is not listed, or you are in a window logged in to the wrong account. Use a private window.'],['Token suddenly stopped working','The client changed their password or removed the app. Generate a new token.'],['The account is personal','Switch it to Business or Creator in Instagram settings.'],['Instagram asks to approve a login','Approve it in the Instagram app on the device where the account is logged in.']]},
google:{name:'Google Business',
 intro:'Posts appear as updates on the client’s Google Business listing. Google must approve API access for our project first, which takes about 7 to 10 business days.',
 groups:[
  {title:'One-time setup (first time only)',open:false,steps:[
   ST('you','Create a Google Cloud project','At console.cloud.google.com, signed in as the account that manages your own Business Profile, create a project for the dashboard.',SH('console.cloud.google.com',['*New project|content-calendar'])),
   ST('you','Request API access','Open Google’s “GBP API contact form” and choose “Application for Basic API Access”. Give the project number, your website and an email that is an owner or manager of a verified Business Profile that is more than 60 days old. Submit it once only; Google opens a support case and answers in about 7 to 10 business days.',SH('Google › Business Profile API access request',['*Request access|Status: pending','Contact email'],'Submit')),
   ST('you','Enable the APIs','In the project: APIs and services, Library, enable My Business Account Management API and My Business Business Information API. After approval the older Google My Business API (the one that publishes posts) also becomes available: enable it too.',SH('Cloud console › APIs and services',['*Enable APIs|Business Profile'])),
   ST('you','Consent screen and login','Create the OAuth consent screen (External), add the scope business.manage, add your Google account as a test user while testing, then create an OAuth client (Web) with the return address https://YOUR-DASHBOARD-ADDRESS/api/google/callback.',SH('Cloud console › OAuth consent screen',['*Scope: business.manage','[x]Return address added'])),
   ST('you','Publish the app','While the app is in “testing”, Google connections expire after 7 days. Publish it (Google may ask to verify it).',SH('Cloud console › OAuth consent screen',['Publishing status|Testing','*Publish app'])),
   ST('you','Save the keys on Vercel','Client ID and client secret as hidden variables, then redeploy. Never paste them in chat.',SH('Vercel › Environment Variables',['GOOGLE_CLIENT_ID','*GOOGLE_CLIENT_SECRET|Encrypted (sensitive)'],'Redeploy'))]},
  {title:'For each new client',open:true,steps:[
   ST('client','Check the listing is verified','Their Google Business listing must exist and be verified (business.google.com).',SH('business.google.com',['*Client name|Verified'])),
   ST('you','Make a link for the client','Dashboard, the client, Channels, Google Business, Get a link for the client. Copy it and send it to them. It works for 7 days.',SH('Dashboard › Channels',['*Google Business|Not connected'],'Get a link for the client')),
   ST('client','The client opens the link and presses Allow','They sign in with the Google account that manages their listing and press Allow. If that account manages several listings, a page asks which one is theirs. They never share a password with us.',SH('accounts.google.com',['*Allow Content Calendar to manage your business?'],'Allow')),
   ST('system','Green dot','The listing appears under Channels with a green dot. Posts from the moment it connects are sent there as updates.',SH('Dashboard › Channels',['*@Client name|Google Business · connected']))]},
  {title:'Check that it works',open:true,steps:[
   ST('you','Look at the first post','After the first scheduled time, check the listing’s Updates: the post appears with its picture. Google updates are short (about 1,500 characters) and hashtags are left out.',SH('Google › Business Profile › Updates',['*Client post|Learn more']))]},
  {title:'Later: reconnect or remove',open:false,steps:[
   ST('you','Reconnect','If the channel turns red, make a new link for the client and ask them to open it and press Allow again.',SH('Dashboard › Channels',['*Reconnect'])),
   ST('client','Remove access','The client removes you under People and access.',SH('business.google.com › People and access',['*Remove|Agency account']))]}],
 problems:[['Connect says “Waiting for Google approval”','The API access request is still pending. Nothing to fix on your side.'],['Connection drops after 7 days','The Google app is still in testing mode. Publish it.'],['Location missing','You were not accepted as a manager for that location, or it is not verified.'],['Post rejected','Google refuses some words and phone numbers in posts. Edit the caption and send it again.']]},
linkedin:{name:'LinkedIn',
 intro:'Posts go to the client’s personal profile. The client approves it themselves with one link and one Allow. Company pages need a separate LinkedIn approval and are not supported yet.',
 groups:[
  {title:'One-time setup (first time only)',open:false,steps:[
   ST('you','Create the LinkedIn app','At developer.linkedin.com, Create app. It must be linked to a LinkedIn company page, and that page’s admin has to verify the link.',SH('developer.linkedin.com › Create app',['*Company page|Your agency page','App name|Content Calendar'],'Create app')),
   ST('you','Add the products','Add “Share on LinkedIn” and “Sign In with LinkedIn using OpenID Connect”. Both are self-serve.',SH('developer.linkedin.com › App › Products',['*Share on LinkedIn|Request access','Sign In with LinkedIn (OpenID)|Added'])),
   ST('you','Add the return address','Auth tab: Authorized redirect URLs, add https://YOUR-DASHBOARD-ADDRESS/api/linkedin-callback.',SH('developer.linkedin.com › App › Auth',['*Authorized redirect URLs|https://…/api/linkedin-callback'],'Update')),
   ST('you','Save the keys on Vercel','Client ID and client secret as hidden variables, then redeploy. Never paste them in chat.',SH('Vercel › Environment Variables',['LINKEDIN_CLIENT_ID','*LINKEDIN_CLIENT_SECRET|Encrypted (sensitive)'],'Redeploy'))]},
  {title:'For each new client',open:true,steps:[
   ST('you','Make a link for the client','Dashboard, the client, Channels, LinkedIn, Get a link for the client. Copy it and send it to them (message or email). It works for 7 days.',SH('Dashboard › Channels',['*LinkedIn|Not connected'],'Get a link for the client')),
   ST('client','The client opens the link and presses Allow','They sign in to their own LinkedIn if asked, and press Allow. We never see their password, and nothing is posted at this point.',SH('linkedin.com › Authorise',['[x]Use your name and photo','[x]*Post on your behalf'],'Allow')),
   ST('system','Green dot and a reminder','The channel shows a green dot and how long the connection lasts. LinkedIn connections last about 60 days and do not renew themselves.',SH('Dashboard › Channels',['*@Client name|LinkedIn · connected · ends in 59 days']))]},
  {title:'Check that it works',open:true,steps:[
   ST('you','Look at the first post','After the first scheduled time, check the profile: the post appears with its picture. The dashboard shows Published with a view link. Only posts dated after the connection are sent.',SH('linkedin.com › Profile',['*Client post|just now']))]},
  {title:'Later: reconnect or remove',open:false,steps:[
   ST('you','Reconnect every ~60 days','A week before it ends you get an alert. Open the client’s LinkedIn row, Get a new link for the client, and send it. Same two clicks for them.',SH('Alert',['*LinkedIn connection ends in 7 days'])),
   ST('client','Remove access','The client can remove the app under LinkedIn Settings, Data privacy, Permitted services, or you disconnect the channel in the dashboard.',SH('linkedin.com › Permitted services',['*Remove|Content Calendar']))]}],
 problems:[['Posting fails after about two months','The connection ended. Make a new link and ask the client to press Allow again.'],['The client sees “something went wrong” on LinkedIn','The return address is missing from the LinkedIn app (Auth tab). Add it exactly as in the setup step.'],['The link says it has expired','Links last 7 days. Make a new one.'],['Cannot verify the app','The company page admin must verify the link between the page and the app.'],['Company pages','Not supported yet: it needs LinkedIn’s separate Community Management approval.']]}
};
