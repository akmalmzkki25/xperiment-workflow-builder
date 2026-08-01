import type { MailMessage } from './sender.js';

/** One place that knows the copy and the URL shape, so the pages and the mail cannot drift. */
export function verifyEmailMessage(to: string, appUrl: string, token: string): MailMessage {
  return {
    to,
    subject: 'Confirm your Xperiment email address',
    text: [
      'Welcome to Xperiment.',
      '',
      'Confirm this address by opening the link below:',
      `${appUrl}/verify-email?token=${token}`,
      '',
      'The link is valid for 24 hours. If you did not create a Xperiment account, ignore this email.',
    ].join('\n'),
  };
}

export function passwordResetMessage(to: string, appUrl: string, token: string): MailMessage {
  return {
    to,
    subject: 'Reset your Xperiment password',
    text: [
      'Someone asked to reset the password for this Xperiment account.',
      '',
      'Set a new password with the link below:',
      `${appUrl}/reset-password?token=${token}`,
      '',
      'The link is valid for 1 hour and can be used once.',
      'If this was not you, ignore this email — your password has not changed.',
    ].join('\n'),
  };
}
