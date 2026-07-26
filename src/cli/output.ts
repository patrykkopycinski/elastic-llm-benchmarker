/**
 * Shared CLI output formatting helpers.
 * Used across cli.ts and extracted command handler modules.
 */

/**
 * Outputs data in either JSON or human-readable format.
 */
export function output(data: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  } else if (typeof data === 'string') {
    process.stdout.write(data + '\n');
  } else {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  }
}

/**
 * Outputs an error in either JSON or human-readable format.
 */
export function outputError(message: string, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify({ error: message }) + '\n');
  } else {
    console.error(`Error: ${message}`);
  }
}

/**
 * Formats a duration in milliseconds to a human-readable string.
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
