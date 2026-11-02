import { json } from './_shared.mjs';
import { importAllPaymentInvoices } from './_payment-import.mjs';

// Run several times a day. The Toronto weekday guard below means it only
// imports on Thursday through Sunday, even through daylight-saving changes.
export const config = { schedule: '0 */6 * * *' };

const torontoWeekday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', weekday: 'short' }).format(new Date());

export default async () => {
  try {
    const weekday = torontoWeekday();
    if (!['Thu', 'Fri', 'Sat', 'Sun'].includes(weekday)) return json({ skipped: true, message: 'GoLime payment email checks run Thursday through Sunday.' });
    const results = await importAllPaymentInvoices();
    return json({ checked: true, weekday, results });
  } catch (error) {
    console.error('Scheduled GoLime payment email import failed:', error);
    return json({ error: error.message || 'Scheduled GoLime payment import failed.' }, 500);
  }
};
