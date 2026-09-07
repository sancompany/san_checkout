/**
 * SAN CHECKOUT v2 — src/config/supabase.js
 * Cliente Supabase do backend do checkout.
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn('[supabase] SUPABASE_URL ou SUPABASE_SERVICE_KEY ausentes no .env.');
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
