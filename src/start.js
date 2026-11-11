import { randomBytes } from 'node:crypto';
import { createDatabase, demoClinics } from './database.js';
import { createServer } from './server.js';

if (process.env.NODE_ENV === 'production') throw new Error('O painel fictício só funciona em desenvolvimento.');

const password = randomBytes(15).toString('base64url');
const database = await createDatabase(password);
const server = await createServer(database);
const port = Number(process.env.PORT ?? 4175);

server.listen(port, '127.0.0.1', () => {
  console.log(`Painel local: http://127.0.0.1:${server.address().port}`);
  console.log(`Senha temporária das contas fictícias: ${password}`);
  for (const clinic of demoClinics) {
    console.log(`${clinic.name}: proprietaria@${clinic.slug}.test, recepcao@${clinic.slug}.test, profissional@${clinic.slug}.test`);
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => database.close()));
}
