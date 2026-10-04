const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function createBackupRunner({ db, storagePath, backupDir, now = () => new Date(), copyUploads = fs.promises.cp }) {
  let running;

  async function runBackup() {
    await fs.promises.mkdir(backupDir, { recursive: true });
    const date = now().toISOString().slice(0, 10);
    const databasePath = path.join(backupDir, `analyzer-${date}.sqlite`);
    const uploadsPath = path.join(backupDir, `uploads-${date}`);
    const failures = [];

    try {
      await fs.promises.access(databasePath);
    } catch {
      const temporaryPath = path.join(backupDir, `.analyzer-${date}-${crypto.randomUUID()}.tmp`);
      try {
        await db.backup(temporaryPath);
        await fs.promises.rename(temporaryPath, databasePath);
      } catch (error) {
        await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
        failures.push(error);
      }
    }

    try {
      await fs.promises.access(uploadsPath);
    } catch {
      const temporaryPath = path.join(backupDir, `.uploads-${date}-${crypto.randomUUID()}.tmp`);
      try {
        await copyUploads(storagePath, temporaryPath, { recursive: true, errorOnExist: true, force: false });
        await fs.promises.rename(temporaryPath, uploadsPath);
      } catch (error) {
        await fs.promises.rm(temporaryPath, { recursive: true, force: true }).catch(() => {});
        failures.push(error);
      }
    }

    if (failures.length) throw new AggregateError(failures, 'One or more daily backups failed.');
  }

  return function backup() {
    if (!running) {
      running = runBackup().finally(() => {
        running = undefined;
      });
    }
    return running;
  };
}

module.exports = { createBackupRunner };
