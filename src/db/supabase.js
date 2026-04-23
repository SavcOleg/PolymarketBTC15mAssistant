import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://bgvbpkgzwomnmhyqfeep.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || "";

let client = null;

export function getSupabase() {
  if (!client) {
    if (!SUPABASE_KEY) {
      console.warn("[DB] SUPABASE_SERVICE_KEY not set — database logging disabled");
      return null;
    }
    client = createClient(SUPABASE_URL, SUPABASE_KEY);
  }
  return client;
}

export async function insertTrade(trade) {
  const sb = getSupabase();
  if (!sb) return null;
  const { data, error } = await sb.from("trades").insert(trade).select().single();
  if (error) { console.error("[DB] insertTrade:", error.message); return null; }
  return data;
}

export async function updateTrade(id, updates) {
  const sb = getSupabase();
  if (!sb) return null;
  const { data, error } = await sb
    .from("trades")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) { console.error("[DB] updateTrade:", error.message); return null; }
  return data;
}

export async function insertTradeSignals(signals) {
  const sb = getSupabase();
  if (!sb) return null;
  const { data, error } = await sb.from("trade_signals").insert(signals).select().single();
  if (error) { console.error("[DB] insertTradeSignals:", error.message); return null; }
  return data;
}

export async function insertMarketSnapshot(snapshot) {
  const sb = getSupabase();
  if (!sb) return null;
  const { error } = await sb.from("market_snapshots").insert(snapshot);
  if (error) console.error("[DB] insertMarketSnapshot:", error.message);
}

export async function insertPriceTick(tick) {
  const sb = getSupabase();
  if (!sb) return null;
  const { error } = await sb.from("price_ticks").insert(tick);
  if (error) console.error("[DB] insertPriceTick:", error.message);
}

export async function insertBacktestRun(run) {
  const sb = getSupabase();
  if (!sb) return null;
  const { data, error } = await sb.from("backtest_runs").insert(run).select().single();
  if (error) { console.error("[DB] insertBacktestRun:", error.message); return null; }
  return data;
}

export async function updateBacktestRun(id, updates) {
  const sb = getSupabase();
  if (!sb) return null;
  const { error } = await sb.from("backtest_runs").update(updates).eq("id", id);
  if (error) console.error("[DB] updateBacktestRun:", error.message);
}

export async function insertBacktestTrades(trades) {
  const sb = getSupabase();
  if (!sb || !trades.length) return;
  const BATCH = 500;
  for (let i = 0; i < trades.length; i += BATCH) {
    const batch = trades.slice(i, i + BATCH);
    const { error } = await sb.from("backtest_trades").insert(batch);
    if (error) console.error("[DB] insertBacktestTrades batch:", error.message);
  }
}

export async function getActiveStrategy(name) {
  const sb = getSupabase();
  if (!sb) return null;
  const { data, error } = await sb
    .from("strategies")
    .select("*")
    .eq("name", name)
    .eq("is_active", true)
    .single();
  if (error) { console.error("[DB] getActiveStrategy:", error.message); return null; }
  return data;
}

export async function getOpenTrades() {
  const sb = getSupabase();
  if (!sb) return [];
  const { data, error } = await sb
    .from("trades")
    .select("*")
    .in("status", ["OPEN", "PENDING"])
    .order("entry_time", { ascending: false });
  if (error) { console.error("[DB] getOpenTrades:", error.message); return []; }
  return data || [];
}

export async function insertSession(session) {
  const sb = getSupabase();
  if (!sb) return null;
  const { data, error } = await sb.from("live_sessions").insert(session).select().single();
  if (error) { console.error("[DB] insertSession:", error.message); return null; }
  return data;
}

export async function upsertSession(session) {
  const sb = getSupabase();
  if (!sb) return null;
  const { data, error } = await sb
    .from("live_sessions")
    .upsert({ ...session, updated_at: new Date().toISOString() }, { onConflict: "id" })
    .select()
    .single();
  if (error) { console.error("[DB] upsertSession:", error.message); return null; }
  return data;
}

export async function updateSession(id, updates) {
  const sb = getSupabase();
  if (!sb) return null;
  const { data, error } = await sb
    .from("live_sessions")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) { console.error("[DB] updateSession:", error.message); return null; }
  return data;
}

export async function listSessions(limit = 50) {
  const sb = getSupabase();
  if (!sb) return [];
  const { data, error } = await sb
    .from("live_sessions")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) { console.error("[DB] listSessions:", error.message); return []; }
  return data || [];
}

export async function getSession(id) {
  const sb = getSupabase();
  if (!sb) return null;
  const { data, error } = await sb
    .from("live_sessions")
    .select("*")
    .eq("id", id)
    .single();
  if (error) { console.error("[DB] getSession:", error.message); return null; }
  return data;
}

export async function deleteSession(id) {
  const sb = getSupabase();
  if (!sb) return false;
  const { error } = await sb.from("live_sessions").delete().eq("id", id);
  if (error) { console.error("[DB] deleteSession:", error.message); return false; }
  return true;
}
