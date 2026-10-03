const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./app');

const app = createApp();
const port = Number(process.env.PORT) || 3000;
const backupDir = path.resolve(process.env.DATA_DIR || 'data', 'backups');

if (process.env.NODE_ENV === 'production' && !process.env.TOKEN_SECRET) {
  throw new Error('Set TOKEN_SECRET to a random value of at least 32 bytes before starting in production.');
}

const backup = async () => {
  fs.mkdirSync(backupDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const filename = path.join(backupDir, `analyzer-${date}.sqlite`);
  if (!fs.existsSync(filename)) {
    await app.locals.db.backup(filename);
    await fs.promises.cp(app.locals.storagePath, path.join(backupDir, `uploads-${date}`), { recursive: true, force: false, errorOnExist: false });
  }
};

const server = app.listen(port, () => {
  console.log(`naib-yahya-analyzer listening on port ${port}`);
  backup().catch((error) => console.error('Database backup failed:', error.message));
});
const backupTimer = setInterval(() => {
  backup().catch((error) => console.error('Database backup failed:', error.message));
}, 24 * 60 * 60 * 1000);
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
