import { authenticatedMembership, json } from './_shared.mjs';
import { importCompanyDispatch } from './_dispatch-import.mjs';

export default async (request) => {
  try {
    const { membership } = await authenticatedMembership(request);
    return json(await importCompanyDispatch(membership.company_id));
  } catch (error) {
    return json({ error: error.message || 'Could not check Gmail.' }, 400);
  }
};
