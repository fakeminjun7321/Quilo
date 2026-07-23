import { MemoryStore } from "./memory-store.js";
import { SupabaseStore } from "./supabase-store.js";

export async function createStore(config) {
  const store = config.storage === "supabase" ? new SupabaseStore(config) : new MemoryStore(config);
  if (typeof store.initialize === "function") await store.initialize();
  return store;
}
