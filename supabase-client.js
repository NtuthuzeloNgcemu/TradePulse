/* -----------------------------------------------
   TradePulse - Supabase client
   Shared across every page that needs auth or data.
   Requires the Supabase JS UMD build to be loaded first.
----------------------------------------------- */

const SUPABASE_URL = "https://qhcblapvvaatevxgeljo.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_X8t8RuwBImraRvRZnNlklg_QDQWLRvj";

const tpClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
