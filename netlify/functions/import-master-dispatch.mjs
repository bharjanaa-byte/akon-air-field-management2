import { json } from './_shared.mjs';
import { importAllDispatches } from './_dispatch-import.mjs';

// Zoho normally delivers the next-day Master Dispatch at about 9:30 PM in
// Toronto. Netlify cron uses UTC, so run at both surrounding half-hours and
// let a Toronto-time guard choose the two useful checks. The manual Settings
// button remains available if a delivery is delayed.
export const config = { schedule: '0,30 * * * *' };

const torontoClock = () => Object.fromEntries(
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)])
);

export default async () => {
  try {
    const { hour, minute } = torontoClock();
    const shouldCheck = (hour === 21 && minute >= 30) || (hour === 22 && minute < 10);
    if (!shouldCheck) return json({ skipped: true, message: 'Master Dispatch import waits for the 9:30 PM Toronto delivery window.' });
    const results = await importAllDispatches();
    return json({ checked: true, results });
  } catch (error) {
    console.error('Scheduled Master Dispatch import failed:', error);
    return json({ error: error.message || 'Scheduled Master Dispatch import failed.' }, 500);
  }
};
