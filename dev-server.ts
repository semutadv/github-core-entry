// Local dev runner: start the forge on an ephemeral port and print the port.
import { createApp } from './app.ts';

const server = createApp();
server.listen(0, () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  console.log(`listening on port ${port}`);
});
