// Client login configuration. Public values only: the Supabase project URL, its
// PUBLISHABLE (browser-safe) key and the api URL. No secret ever goes here.
// anonKey is filled in at deploy time from Supabase → Settings → API Keys →
// "Publishable key".
window.LI_AUTH_CONFIG = {
  supabaseUrl: 'https://cwrrxieahrcustjvpqsk.supabase.co',
  anonKey: 'sb_publishable_K59kG7431SGi8J3BP3SjBw_zHzuJ-JE',   // Supabase publishable key: browser-safe by design
  apiUrl: 'https://cwrrxieahrcustjvpqsk.supabase.co/functions/v1/api',
};
