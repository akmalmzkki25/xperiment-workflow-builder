import { CONNECTION_PAYLOAD_SCHEMAS, type ConnectorKey } from './payloads.js';

/**
 * How a person actually obtains each credential Xperiment accepts.
 *
 * Knowing *which* connection a workflow needs was never the hard part —
 * `validateWorkflow` has always been able to say `connection_required` on a node. What
 * nothing in the product could say was "go and talk to @BotFather, and by the way the
 * chat id is not on this form", so somebody told to connect Telegram arrived at a
 * two-field form and stopped.
 *
 * Typed as an exhaustive `Record<ConnectorKey, …>` rather than an optional side table.
 * `ConnectorKey` is derived from `CONNECTION_PAYLOAD_SCHEMAS`, so an eleventh payload
 * schema makes this object fail to compile until its guide is written. The weaker
 * arrangement has already been tried here: `NODE_GLYPHS` covered 10 of 18 node types
 * precisely because nothing made the other 8 fail.
 */

export interface CredentialGuideField {
  /** A key of this connector's payload schema. A drift test enforces the correspondence. */
  name: string;
  /** What the connection form calls it. */
  label: string;
  /** One sentence: where this value comes from. */
  help: string;
  /** A SHAPE, never a working value. Long examples must announce themselves. */
  example?: string;
  /** Drives the masked input and the "never paste this in chat" line. */
  secret: boolean;
}

export interface CredentialGuideStep {
  /** Imperative, one line. Something the person does OUTSIDE Xperiment. */
  title: string;
  /** What to do, and what comes back. */
  detail: string;
}

export interface CredentialGuide {
  displayName: string;
  /** One sentence naming what they are about to go and get. */
  summary: string;
  steps: CredentialGuideStep[];
  /** One entry per payload field, in the order the form shows them. */
  fields: CredentialGuideField[];
  /** The things that will bite. An empty array is a choice, not an oversight. */
  cautions: string[];
  docsUrl?: string;
}

export const CREDENTIAL_GUIDES: Record<ConnectorKey, CredentialGuide> = {
  telegram: {
    displayName: 'Telegram',
    summary: 'You need a bot token from BotFather, and the chat id of wherever the bot should post.',
    steps: [
      {
        title: 'Open Telegram and start a chat with @BotFather',
        detail:
          'BotFather is the official bot for making bots. Match the username exactly — there are impostors with lookalike names.',
      },
      {
        title: 'Send /newbot and answer its two questions',
        detail:
          'It asks for a display name, then a username that has to end in "bot". It replies with a token on a line of its own, shaped like 123456789:AAE…',
      },
      {
        title: 'Paste the token into the Xperiment connection form',
        detail:
          'Into the form Xperiment opens for you — never into a chat. Anyone holding that token can send messages as your bot.',
      },
      {
        title: 'Give the bot something to see',
        detail:
          'For a private chat, message the bot directly. For a group, add it to the group and post once. A bot cannot see a conversation nobody has spoken to it in.',
      },
      {
        title: 'Read the chat id back from getUpdates',
        detail:
          'Open https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates in a browser and find "chat":{"id":…}. A personal chat is a positive number; a group is negative, like -1001234567890.',
      },
    ],
    fields: [
      {
        name: 'botToken',
        label: 'Bot token',
        help: 'The line BotFather sent you after /newbot.',
        example: '123456789:AAExampleExampleExampleExample',
        secret: true,
      },
      {
        name: 'baseUrl',
        label: 'API base URL',
        help: 'Leave blank unless you route Telegram through a proxy.',
        example: 'https://api.telegram.org',
        secret: false,
      },
    ],
    cautions: [
      'The chat id is not part of this credential. Xperiment asks for it on the Send Telegram message node, not on this form.',
      'A bot cannot start a conversation. Somebody has to message it, or add it to the group, first.',
      'If getUpdates comes back with an empty result list, nobody has spoken to the bot yet.',
    ],
    docsUrl: 'https://core.telegram.org/bots/features#botfather',
  },

  whatsapp: {
    displayName: 'WhatsApp Business',
    summary: 'You need an access token and the phone number ID from a Meta business app.',
    steps: [
      {
        title: 'Create a Business app at developers.facebook.com',
        detail: 'Choose the Business type, then add the WhatsApp product to it. A test number is provisioned for you.',
      },
      {
        title: 'Copy the Phone number ID, not the phone number',
        detail:
          'On the WhatsApp API Setup panel it sits under the sender dropdown. It is a long numeric id, and it is not the number you would dial.',
      },
      {
        title: 'Get a token that outlives today',
        detail:
          'The temporary token on that panel expires in 24 hours. For anything real, create a System User in Business Settings and issue a token with the whatsapp_business_messaging permission.',
      },
    ],
    fields: [
      { name: 'accessToken', label: 'Access token', help: 'From the API Setup panel or your System User.', secret: true },
      {
        name: 'phoneNumberId',
        label: 'Phone number ID',
        help: 'The numeric id of the sender, from the same panel.',
        example: '1234567890',
        secret: false,
      },
      { name: 'baseUrl', label: 'API base URL', help: 'Leave blank for graph.facebook.com.', secret: false },
    ],
    cautions: [
      'Outside the 24-hour customer service window you may only send a pre-approved template. That is why the node takes templateName as well as text.',
      'A temporary token works perfectly today and fails tomorrow morning, which is a confusing way to find out.',
    ],
    docsUrl: 'https://developers.facebook.com/docs/whatsapp/cloud-api/get-started',
  },

  slack: {
    displayName: 'Slack',
    summary: 'You need a bot token from a Slack app you install into your workspace.',
    steps: [
      {
        title: 'Create an app at api.slack.com/apps',
        detail: 'Choose "From scratch", name it, and pick the workspace it belongs to.',
      },
      {
        title: 'Add the chat:write scope under OAuth and Permissions',
        detail: 'It has to go under Bot Token Scopes, not User Token Scopes. Those produce different tokens.',
      },
      {
        title: 'Install to Workspace and copy the Bot User OAuth Token',
        detail:
          'It begins with xoxb-. The xoxp- token on the same page acts as you rather than as the app, and will not work here.',
      },
      {
        title: 'Invite the bot to the channel',
        detail: 'Type /invite @yourbot in each channel it should post to. Slack will not let an app post somewhere it is not a member.',
      },
    ],
    fields: [
      {
        name: 'botToken',
        label: 'Bot token',
        help: 'The xoxb- token from OAuth and Permissions.',
        example: 'xoxb-your-token-here',
        secret: true,
      },
      { name: 'baseUrl', label: 'API base URL', help: 'Leave blank for slack.com.', secret: false },
    ],
    cautions: [
      'It has to be the xoxb- token. An xoxp- token authenticates as a person and Slack rejects it for app posting.',
      'A not_in_channel error means the invite step was skipped, not that the token is wrong.',
    ],
    docsUrl: 'https://api.slack.com/authentication/basics',
  },

  smtp: {
    displayName: 'Email (SMTP)',
    summary: 'You need the SMTP host, port and login that your mail provider issues.',
    steps: [
      {
        title: 'Find the SMTP settings in your mail provider',
        detail: 'Look for "SMTP", "outgoing mail" or "sending". You want a host, a port, a username and a password.',
      },
      {
        title: 'For Gmail, create an App Password',
        detail:
          'Your account password will not work. Turn on 2-step verification, then create an App Password and use that. For SendGrid the username is the literal word apikey.',
      },
      {
        title: 'Match the port to the security setting',
        detail:
          'Port 465 means secure on, because TLS starts immediately. Port 587 means secure off, because it upgrades with STARTTLS after connecting.',
      },
    ],
    fields: [
      { name: 'host', label: 'SMTP host', help: 'For example smtp.gmail.com.', example: 'smtp.gmail.com', secret: false },
      { name: 'port', label: 'Port', help: '465 for implicit TLS, 587 for STARTTLS.', example: '587', secret: false },
      { name: 'user', label: 'Username', help: 'Usually the full email address.', secret: false },
      { name: 'password', label: 'Password', help: 'An App Password for Gmail, not your account password.', secret: true },
      { name: 'from', label: 'From address', help: 'The address recipients will see.', example: 'kirim@tokoanda.co.id', secret: false },
      { name: 'secure', label: 'Use TLS on connect', help: 'On for port 465, off for 587.', secret: false },
    ],
    cautions: [
      'The from address has to be one the provider lets you send as, or the mail is rejected or filed as spam with no error you will ever see.',
      'Port 587 with secure on fails as a connection timeout, which looks like a firewall problem and is not.',
    ],
  },

  postgres: {
    displayName: 'PostgreSQL',
    summary: 'You need one connection string carrying the host, database, user and password.',
    steps: [
      {
        title: 'Open your database provider console',
        detail:
          'Supabase puts it under Settings then Database. Neon calls it Connection Details. A self-hosted server has whatever your admin set.',
      },
      {
        title: 'Prefer the pooled or session connection string',
        detail: 'A workflow opens short connections often. The direct string runs out of slots faster than the pooled one does.',
      },
      {
        title: 'Escape the password and require TLS',
        detail:
          'Percent-encode any @ : / or ? in the password, or the URL parses wrong. For a hosted database append sslmode=require.',
      },
    ],
    fields: [
      {
        name: 'connectionString',
        label: 'Connection string',
        help: 'postgresql://user:password@host:5432/database',
        example: 'postgresql://user:...@host:5432/dbname',
        secret: true,
      },
    ],
    cautions: [
      'This one string can read and write everything the role can. Create a dedicated least-privilege role rather than reusing the owner.',
      'A hosted database will usually also need the address Xperiment connects from allowed through its firewall.',
    ],
  },

  openai: {
    displayName: 'OpenAI',
    summary: 'You need a secret API key from an OpenAI project that has credit on it.',
    steps: [
      { title: 'Go to platform.openai.com and open API keys', detail: 'Sign in with the account that owns the project you want billed.' },
      {
        title: 'Create a new secret key and copy it now',
        detail: 'It is shown exactly once. If you lose it, the only path is to create another and revoke this one.',
      },
      {
        title: 'Check the project has credit',
        detail: 'A key on a project with no balance authenticates fine and then fails on every call.',
      },
    ],
    fields: [
      { name: 'apiKey', label: 'API key', help: 'The sk- key from the API keys page.', example: 'sk-proj-your-key-here', secret: true },
      { name: 'baseUrl', label: 'API base URL', help: 'Leave blank for api.openai.com.', secret: false },
    ],
    cautions: ['A project with no credit fails as a 429, which reads like rate limiting and is not.'],
    docsUrl: 'https://platform.openai.com/api-keys',
  },

  gemini: {
    displayName: 'Google Gemini',
    summary: 'You need an API key from Google AI Studio, tied to a Cloud project.',
    steps: [
      { title: 'Go to aistudio.google.com and choose Get API key', detail: 'Sign in with the Google account you want this billed to.' },
      { title: 'Pick or create a Google Cloud project', detail: 'The key belongs to that project, and quota and billing follow it.' },
      {
        title: 'Copy the key into the Xperiment form',
        detail: 'AI Studio will show it again later, unlike OpenAI, but treat it as a secret regardless.',
      },
    ],
    fields: [
      { name: 'apiKey', label: 'API key', help: 'From Google AI Studio.', example: 'AIza-your-key-here', secret: true },
      { name: 'baseUrl', label: 'API base URL', help: 'Leave blank for the default endpoint.', secret: false },
    ],
    cautions: ['Free-tier availability depends on the region of the Cloud project, not on where you are sitting.'],
    docsUrl: 'https://aistudio.google.com/apikey',
  },

  midtrans: {
    displayName: 'Midtrans',
    summary: 'You need the Server key from your Midtrans dashboard, sandbox or production.',
    steps: [
      {
        title: 'Open dashboard.midtrans.com, then Settings and Access Keys',
        detail: 'Use the environment toggle to pick Sandbox or Production before you copy anything.',
      },
      {
        title: 'Copy the Server key, not the Client key',
        detail:
          'Sandbox server keys begin SB-Mid-server-, production ones Mid-server-. The Client key is a browser value and Xperiment deliberately does not store it.',
      },
      {
        title: 'Point the base URL at the matching environment',
        detail: 'A sandbox key against the production host authenticates as nobody and fails 401.',
      },
    ],
    fields: [
      { name: 'serverKey', label: 'Server key', help: 'From Settings and Access Keys.', example: 'SB-Mid-server-your-key', secret: true },
      { name: 'baseUrl', label: 'API base URL', help: 'The sandbox or production Snap host.', secret: false },
    ],
    cautions: [
      'Mixing a sandbox key with a production host is the most common Midtrans setup error, and the 401 says nothing about it.',
      'Xperiment has no connection test for Midtrans on purpose — Snap has no side-effect-free probe, and inventing one by posting a throwaway transaction is worse than having none.',
    ],
    docsUrl: 'https://docs.midtrans.com/docs/snap-snap-integration-guide',
  },

  xendit: {
    displayName: 'Xendit',
    summary: 'You need a secret API key with money-in write permission.',
    steps: [
      {
        title: 'Open dashboard.xendit.co, then Settings, Developers and API Keys',
        detail: 'Switch the dashboard into Test Mode first if you want a test key.',
      },
      {
        title: 'Generate a secret key with Money-in set to Write',
        detail: 'Read-only looks fine when you save it and fails when a workflow tries to create an invoice.',
      },
      { title: 'Copy it once', detail: 'Xendit shows the secret only at creation. Losing it means generating another.' },
    ],
    fields: [
      { name: 'secretKey', label: 'Secret key', help: 'The xnd_ key from the API Keys page.', example: 'xnd_development_your-key', secret: true },
      { name: 'baseUrl', label: 'API base URL', help: 'Leave blank for api.xendit.co.', secret: false },
    ],
    cautions: ['Read-only permission produces a 403 at run time, not when the connection is tested.'],
    docsUrl: 'https://docs.xendit.co/developer-tools/api-keys',
  },

  googleSheets: {
    displayName: 'Google Sheets',
    summary: 'You need a service account key file, and the sheet has to be shared with that service account.',
    steps: [
      { title: 'Open the Google Cloud console and pick or create a project', detail: 'Everything below happens inside that one project.' },
      {
        title: 'Enable the Google Sheets API',
        detail: 'APIs and Services, then Library, then Google Sheets API, then Enable. Skipping this gives a 403 that never mentions the API.',
      },
      {
        title: 'Create a service account and download a JSON key',
        detail: 'IAM and Admin, then Service Accounts, then Create. Under Keys choose Add key and JSON. The file downloads once.',
      },
      {
        title: 'Copy client_email and private_key out of that file',
        detail: 'They go into the two fields below. The private key is multi-line with escaped newlines — paste it exactly as it appears.',
      },
      {
        title: 'Share the spreadsheet with the service account',
        detail: 'Open the sheet, press Share, and add the client_email address as an Editor. Exactly as you would share it with a colleague.',
      },
    ],
    fields: [
      {
        name: 'serviceAccountEmail',
        label: 'Service account email',
        help: 'The client_email field from the JSON key.',
        example: 'xperiment@your-project.iam.gserviceaccount.com',
        secret: false,
      },
      { name: 'privateKey', label: 'Private key', help: 'The private_key field from the JSON key, pasted whole.', secret: true },
      { name: 'baseUrl', label: 'Sheets API base URL', help: 'Leave blank for the default.', secret: false },
      { name: 'tokenUrl', label: 'Token URL', help: 'Leave blank for the default OAuth endpoint.', secret: false },
      {
        name: 'testSpreadsheetId',
        label: 'Test spreadsheet id',
        help: 'Optional. A sheet the connection test may read, to prove the sharing worked.',
        secret: false,
      },
    ],
    cautions: [
      'Forgetting to share the sheet is the usual failure, and it surfaces as a 403 that never says the word sharing.',
      'A service account is not you. Access you have in the browser tells you nothing about what it can reach.',
    ],
    docsUrl: 'https://developers.google.com/workspace/guides/create-credentials#service-account',
  },
};

/** Present so the exhaustive map above cannot be quietly widened to a partial one. */
export const CREDENTIAL_GUIDE_KEYS = Object.keys(CONNECTION_PAYLOAD_SCHEMAS) as ConnectorKey[];
