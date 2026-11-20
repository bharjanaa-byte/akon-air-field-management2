import { authenticatedMembership, admin, json, makeState, siteUrl } from './_shared.mjs';

// Create a short-lived, signed link. This lets a Home Screen app open the
// report in Safari without putting a Supabase access token in a URL.
export default async request => {
  try {
    const { membership } = await authenticatedMembership(request);
    const jobId = new URL(request.url).searchParams.get('jobId');
    if (!jobId) throw new Error('Choose a job before preparing its report.');
    const { data: job, error } = await admin().from('jobs').select('id').eq('id', jobId).eq('company_id', membership.company_id).maybeSingle();
    if (error || !job) throw new Error('This job is not available in the shared workspace yet. Sync, then try again.');
    const state = makeState({ type: 'completion-report', jobId, companyId: membership.company_id });
    return json({ url: `${siteUrl(request)}/.netlify/functions/completion-report?state=${encodeURIComponent(state)}` });
  } catch (error) {
    return json({ error: error.message || 'Could not prepare the report link.' }, 400);
  }
};
