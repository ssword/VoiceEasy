export function safeErrorMetadata(error: unknown) {
  if (!(error instanceof Error)) return { name: 'UnknownError' }
  const candidate = error as Error & { code?: unknown; status?: unknown; statusCode?: unknown }
  return {
    name: error.name,
    ...(typeof candidate.code === 'string' || typeof candidate.code === 'number'
      ? { code: candidate.code }
      : {}),
    ...(typeof candidate.statusCode === 'number'
      ? { status: candidate.statusCode }
      : typeof candidate.status === 'number'
      ? { status: candidate.status }
      : {}),
  }
}
