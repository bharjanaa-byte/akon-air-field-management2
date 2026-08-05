import { admin, authenticatedMembership, json } from './_shared.mjs';

export default async (request) => {
  try {
    const { membership } = await authenticatedMembership(request);
    const { data, error } = await admin().from('gmail_integrations').select('gmail_address,last_import_at').eq('company_id', membership.company_id).maybeSingle();
    if (error) throw error;
    return json({ connected: !!data, gmailAddress: data?.gmail_address || '', lastImportAt: data?.last_import_at || null });
  } catch (error) {
    return json({ error: error.message }, 400);
  }
};
