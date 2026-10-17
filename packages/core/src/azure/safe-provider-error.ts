/**
 * Azure SDK errors can retain the full request, including its Authorization header. Preserve the
 * useful HTTP classification while deliberately dropping the credential-bearing request object.
 */
function safeAzureProviderError(
  component: 'blob' | 'key-vault',
  operation: string,
  error: unknown,
): Error {
  const statusCode =
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof error.statusCode === 'number'
      ? error.statusCode
      : undefined;
  const cause = new Error(
    statusCode === undefined
      ? 'Azure service request failed.'
      : `Azure service returned HTTP ${String(statusCode)}.`,
  );
  cause.name = 'AzureServiceError';
  return new Error(`Azure ${component} ${operation} failed.`, { cause });
}

export async function azureProviderCall<T>(
  component: 'blob' | 'key-vault',
  operation: string,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw safeAzureProviderError(component, operation, error);
  }
}
