export function intFromEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

