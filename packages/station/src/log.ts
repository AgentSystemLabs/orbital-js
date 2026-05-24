export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

export type Logger = (level: LogLevel, event: string, fields?: LogFields) => void;

export type MetricFields = Record<string, string | number | boolean>;

export type MetricRecorder = (
  name: string,
  value: number,
  tags?: MetricFields
) => void;

export const defaultLogger: Logger = (level, event, fields) => {
  const payload = fields && Object.keys(fields).length ? fields : undefined;
  const tag = `station:${event}`;
  if (level === "error") {
    if (payload) console.error(tag, payload);
    else console.error(tag);
    return;
  }
  if (level === "warn") {
    if (payload) console.warn(tag, payload);
    else console.warn(tag);
    return;
  }
  if (level === "info") {
    if (payload) console.log(tag, payload);
    else console.log(tag);
    return;
  }
  // debug — only when STATION_DEBUG is set.
  if (process.env.STATION_DEBUG) {
    if (payload) console.log(tag, payload);
    else console.log(tag);
  }
};

export const noopMetric: MetricRecorder = () => {};
