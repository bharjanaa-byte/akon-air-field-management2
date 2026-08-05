import { admin, callbackUrl, env, readState, siteUrl } from './_shared.mjs';

export default async (request) => {
  try {
    const url = new URL(request.url);
    if (url.searchParams.get('error')) throw new Error('Google connection was cancelled.');
    const state = readState(url.searchParams.get('state'));
    const body = new URLSearchParams({ code: url.searchParams.get('code') || '', client_id: env('GMAIL_CLIENT_ID'), client_secret: env('GMAIL_CLIENT_SECRET'), redirect_uri: callbackUrl(request), grant_type: 'authorization_code' });
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    const token = await tokenResponse.json();
    if (!tokenResponse.ok || !token.refresh_token) throw new Error('Google did not provide a long-term connection. Please connect again.');
    const profile = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { authorization: `Bearer ${token.access_token}` } }).then(response => response.json());
    const { error } = await admin().from('gmail_integrations').upsert({ company_id: state.companyId, connected_by: state.userId, gmail_address: profile.emailAddress || null, refresh_token: token.refresh_token, last_message_id: null, last_import_at: null }, { onConflict: 'company_id' });
    if (error) throw error;
    return Response.redirect(`${siteUrl(request)}/?gmail=connected`, 302);
  } catch (error) {
    return new Response(`Gmail connection could not be completed: ${error.message}`, { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
};
