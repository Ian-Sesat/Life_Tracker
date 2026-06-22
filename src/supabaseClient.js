import { createClient } from "@supabase/supabase-js";

// These two values come from your Supabase project:
//   Dashboard -> Project Settings -> API
//   - Project URL  -> VITE_SUPABASE_URL
//   - anon public key -> VITE_SUPABASE_ANON_KEY
//
// Put them in a file named ".env" at the project root (see .env.example),
// or set them in Vercel's Environment Variables when you deploy.
// The anon key is safe to expose in the browser; row-level security (set up in
// supabase-setup.sql) is what actually protects each person's data.

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabaseConfigured = Boolean(url && anonKey);

export const supabase = supabaseConfigured
  ? createClient(url, anonKey)
  : null;
