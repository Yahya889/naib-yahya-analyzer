const path = require('node:path');
const { createApp } = require('./app');
const { createBackupRunner } = require('./backups');

const app = createApp();
const port = Number(process.env.PORT) || 3000;
const backupDir = path.resolve(process.env.DATA_DIR || 'data', 'backups');

if (process.env.NODE_ENV === 'production' && !process.env.TOKEN_SECRET) {
  throw new Error('Set TOKEN_SECRET to a random value of at least 32 bytes before starting in production.');
}

const backup = createBackupRunner({
  db: app.locals.db,
  storagePath: app.locals.storagePath,
  backupDir
});

const server = app.listen(port, () => {
  console.log(`naib-yahya-analyzer listening on port ${port}`);
  backup().catch((error) => console.error('Daily backup attempt failed:', error.message));
});
const backupTimer = setInterval(() => {
  backup().catch((error) => console.error('Daily backup attempt failed:', error.message));
}, 5 * 60 * 1000);
backupTimer.unref();

function shutdown() {
  clearInterval(backupTimer);
  server.close(() => {
    app.locals.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
