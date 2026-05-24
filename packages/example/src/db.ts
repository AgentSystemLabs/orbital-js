import postgres from "postgres";

export const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://station:station@localhost:5434/station";

export const sql = postgres(DATABASE_URL, {
  max: 10,
  onnotice: () => {},
});
