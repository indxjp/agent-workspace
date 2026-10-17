// Structured JSON-lines logger (Cloud Logging reads `severity` + `message`).
// Callers pass explicit fields only; nothing here ever serialises a request's
// headers, so an Authorization value cannot reach the log by accident.
export function createLogger({
  write = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  const emit =
    (severity) =>
    (message, fields = {}) =>
      write(
        JSON.stringify({
          severity,
          time: new Date().toISOString(),
          message,
          ...fields,
        }),
      );
  return { info: emit("INFO"), warn: emit("WARNING"), error: emit("ERROR") };
}
