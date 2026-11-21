export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { resumeStreams } = await import("./lib/streams/kafka");
  await resumeStreams();
}
