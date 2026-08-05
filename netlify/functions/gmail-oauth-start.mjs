import { authenticatedMembership, callbackUrl, env, json, makeState } from './_shared.mjs';

export default async (request) => {
  try {
    const { user, membership } = await authenticatedMembership(request);
    const params = new URLSearchParams({
      client_id: env('GMAIL_CLIENT_ID'), redirect_uri: callbackUrl(request), response_type: 'code',
      scope: 'https://www.googleapis.com/auth/gmail.readonly', access_type: 'offline', prompt: 'consent',
      state: makeState({ companyId: membership.company_id, userId: user.id })
    });
    return json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
  } catch (error) {
    return json({ error: error.message }, 400);
  }
};
