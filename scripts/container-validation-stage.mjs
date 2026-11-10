/** Keep asynchronous validation alive, bounded, and attributable to one stage. */
export async function runValidationStage(name, operation, timeoutMs = 45_000) {
  process.stdout.write(`Container validation: ${name}\n`);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        // A referenced deadline also prevents a pending top-level await from
        // silently ending with exit 13 when no other handles remain.
        timer = setTimeout(() => reject(new Error(`Container validation timed out: ${name}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
