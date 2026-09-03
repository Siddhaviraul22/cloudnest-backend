const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

const storageBucket = process.env.SUPABASE_STORAGE_BUCKET || "cloudnest";

module.exports = {
  supabase,
  storageBucket
};