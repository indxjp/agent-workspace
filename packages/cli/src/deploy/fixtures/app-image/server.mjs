// The stand-in app: /api/health answers 200, as the app template's route does; anything else 404.
import { createServer } from 'node:http';
import process from 'node:process';

const server = createServer((request, response) => {
  const healthy = request.url === '/api/health';
  response.writeHead(healthy ? 200 : 404, { 'cache-control': 'no-store' });
  response.end(healthy ? 'ok' : 'not found');
});
// Every interface: Docker sets HOSTNAME to the container id, which is not loopback.
server.listen(3000, '0.0.0.0');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
