import { authenticatedMembership, json } from './_shared.mjs';
import { importCompanyPaymentInvoices } from './_payment-import.mjs';

export default async (request) => {
  try {
    const { membership } = await authenticatedMembership(request);
    return json(await importCompanyPaymentInvoices(membership.company_id));
  } catch (error) {
    return json({ error: error.message || 'Could not check GoLime payment email.' }, 400);
  }
};
