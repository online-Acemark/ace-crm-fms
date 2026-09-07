import { createClient } from '@supabase/supabase-js'

// values .env file se aati hain (VITE_ prefix zaroori hai) — .env git me commit NAHI hota
export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
export const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!SUPABASE_URL || !SUPABASE_ANON) {
  throw new Error('.env file me VITE_SUPABASE_URL aur VITE_SUPABASE_ANON_KEY set karo (.env.example dekho)')
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON)
