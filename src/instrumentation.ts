export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { resumeStreams } = await import("./lib/streams/kafka");
  const { startAlertScheduler } = await import("./lib/alerts/runner");
  startAlertScheduler();
  await resumeStreams();
}
