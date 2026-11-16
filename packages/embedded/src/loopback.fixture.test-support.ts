import { createServer } from 'node:net';
/** Hold a loopback port with a listening server; resolves with the server and its port. */
export async function holdLoopbackPort(): Promise<{
  readonly server: ReturnType<typeof createServer>;
  readonly port: number;
}> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { server, port: address.port };
}

export function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}
