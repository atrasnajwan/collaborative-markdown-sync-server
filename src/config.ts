import { intFromEnv } from "./env.js";

export type Config = {
  PORT: number;
  HOST: string;
};

export const config: Config = {
  PORT: intFromEnv("PORT", 8787),
  HOST: process.env.HOST ?? "0.0.0.0"
};


