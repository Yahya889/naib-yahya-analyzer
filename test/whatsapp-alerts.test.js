const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { test } = require('node:test');
const { createPermitAlertRunner, createWhatsAppSender } = require('../src/whatsapp-alerts');

const config = {
  WHATSAPP_ACCESS_TOKEN: 'test-access-token',
  WHATSAPP_PHONE_NUMBER_ID: '1234567890',
  WHATSAPP_ALERT_RECIPIENT: '966500000000',
  WHATSAPP_TEMPLATE_NAME: 'permit_expiry_alert',
  WHATSAPP_TEMPLATE_LANGUAGE: 'ar',
  WHATSAPP_API_VERSION: 'v99.0'
};

test('WhatsApp sender targets only the configured recipient with the approved template', async () => {
  let request;
  const sender = createWhatsAppSender(config, async (url, options) => {
    request = { url, options };
    return { ok: true };
  });
  assert.equal(typeof sender, 'function');
  await sender({
    permit_number: 'VP-100',
    vehicle_plate: 'ABC 123',
    valid_until: '2026-10-25',
    alert_type: 'expiring'
  });
  assert.equal(request.url, 'https://graph.facebook.com/v99.0/1234567890/messages');
  assert.equal(request.options.headers.Authorization, ['Bearer', config.WHATSAPP_ACCESS_TOKEN].join(' '));
  const payload = JSON.parse(request.options.body);
  assert.equal(payload.to, config.WHATSAPP_ALERT_RECIPIENT);
  assert.equal(payload.type, 'template');
  assert.deepEqual(payload.template.components[0].parameters.map((parameter) => parameter.text), [
    'VP-100', 'ABC 123', '2026-10-25', 'ينتهي خلال 30 يوماً'
  ]);
});

test('WhatsApp sender is disabled without configuration and rejects partial configuration', () => {
  assert.equal(createWhatsAppSender({}), null);
  assert.throws(() => createWhatsAppSender({ WHATSAPP_ACCESS_TOKEN: 'configured' }), /all WhatsApp Cloud API/);
  assert.throws(() => createWhatsAppSender({
    ...config,
    WHATSAPP_ALERT_RECIPIENT: '+12345'
  }), /configuration is invalid/);
});

test('permit alerts are delivered once per alert state and failed sends are retried after cooldown', async () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE vehicle_permits (
      id INTEGER PRIMARY KEY,
      permit_number TEXT NOT NULL,
      vehicle_plate TEXT NOT NULL,
      valid_from TEXT NOT NULL,
      valid_until TEXT NOT NULL
    );
    INSERT INTO vehicle_permits (permit_number, vehicle_plate, valid_from, valid_until)
      VALUES ('VP-SOON', 'ABC 123', '2026-10-01', '2026-10-25');
    INSERT INTO vehicle_permits (permit_number, vehicle_plate, valid_from, valid_until)
      VALUES ('VP-EXPIRED', 'XYZ 987', '2026-01-01', '2026-10-10');
    INSERT INTO vehicle_permits (permit_number, vehicle_plate, valid_from, valid_until)
      VALUES ('VP-FUTURE', 'FUT 456', '2026-11-01', '2026-12-01');
  `);
  let currentTime = new Date('2026-10-18T12:00:00.000Z');
  const deliveries = [];
  let shouldFail = true;
  const run = createPermitAlertRunner({
    db,
    now: () => currentTime,
    sendAlert: async (alert) => {
      deliveries.push(alert);
      if (shouldFail && alert.alert_type === 'expiring') throw new Error('temporary provider failure');
    }
  });

  assert.deepEqual(await run(), { disabled: false, sent: 1, pending: 1 });
  assert.deepEqual(await run(), { disabled: false, sent: 0, pending: 0 });
  shouldFail = false;
  currentTime = new Date('2026-10-18T13:00:00.000Z');
  assert.deepEqual(await run(), { disabled: false, sent: 1, pending: 0 });
  assert.equal(deliveries.filter((alert) => alert.alert_type === 'expiring').length, 2);
  assert.equal(deliveries.filter((alert) => alert.alert_type === 'expired').length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM permit_alert_deliveries').get().count, 2);
  db.close();
});
