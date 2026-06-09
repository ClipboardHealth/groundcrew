const PLAIN_TASK_ID_RE = /^[\da-z]+(?:-[\da-z]+)*$/;

function invalidPlainTaskIdError(task: string): Error {
  return new Error(`Invalid task "${task}": must be a plain task id`);
}

export function isPlainTaskId(task: string): boolean {
  return PLAIN_TASK_ID_RE.test(task);
}

export function assertPlainTaskId(task: string): void {
  if (!isPlainTaskId(task)) {
    throw invalidPlainTaskIdError(task);
  }
}

export function normalizePlainTaskId(task: string): string {
  const normalized = task.toLowerCase();
  if (!isPlainTaskId(normalized)) {
    throw invalidPlainTaskIdError(task);
  }
  return normalized;
}
