import postgres from "postgres";

export const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://parabola:parabola@localhost:5434/parabola";

export const sql = postgres(DATABASE_URL, {
  max: 10,
  onnotice: () => {},
});
