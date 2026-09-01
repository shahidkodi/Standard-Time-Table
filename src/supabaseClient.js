import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabaseReady = Boolean(url && anon);

function makeStub() {
  const noop = async () => ({});
  const queryChain = {
    select() { return this; },
    eq() { return this; },
    async single() { return { data: null, error: true }; },
  };
  const channelStub = {
    on() { return this; },
    subscribe() { return this; },
  };
  return {
    auth: {
      async getSession() { return { data: { session: null } }; },
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      async signInWithPassword() { return { error: { message: "Supabase not configured" } }; },
      async signOut() {},
    },
    from() { return { ...queryChain, upsert: noop }; },
    channel() { return channelStub; },
    removeChannel() {},
  };
}

export const supabase = supabaseReady ? createClient(url, anon) : makeStub();
