import { supabase, supabaseReady } from "./supabaseClient";

const ROW_ID = "main";
const LS_KEY = "tt_cfg_cache";

// Load the shared timetable config. Falls back to a local cache when offline.
export async function loadConfig() {
  if (supabaseReady) {
    try {
      const { data, error } = await supabase.from("timetables").select("data").eq("id", ROW_ID).single();
      if (!error && data && data.data) {
        localStorage.setItem(LS_KEY, JSON.stringify(data.data));
        return data.data;
      }
    } catch {}
  }
  const cached = localStorage.getItem(LS_KEY);
  return cached ? JSON.parse(cached) : null;
}

// Save the whole config as a single row (jsonb). Local cache always updated first.
export async function saveConfig(cfg) {
  localStorage.setItem(LS_KEY, JSON.stringify(cfg));
  if (!supabaseReady) return;
  const { error } = await supabase
    .from("timetables")
    .upsert({ id: ROW_ID, data: cfg, updated_at: new Date().toISOString() });
  if (error) throw error;
}

// Live updates when another staff member saves a change.
export function subscribeConfig(onChange) {
  if (!supabaseReady) return null;
  return supabase
    .channel("tt-main")
    .on("postgres_changes", { event: "*", schema: "public", table: "timetables", filter: `id=eq.${ROW_ID}` },
      (payload) => onChange(payload.new && payload.new.data))
    .subscribe();
}
