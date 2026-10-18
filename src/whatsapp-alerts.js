function createWhatsAppSender(config = process.env, fetchImpl = fetch) {
  const {
    WHATSAPP_ACCESS_TOKEN: accessToken,
    WHATSAPP_PHONE_NUMBER_ID: phoneNumberId,
    WHATSAPP_ALERT_RECIPIENT: recipient,
    WHATSAPP_TEMPLATE_NAME: templateName,
    WHATSAPP_TEMPLATE_LANGUAGE: templateLanguage,
    WHATSAPP_API_VERSION: apiVersion
  } = config;
  const values = [accessToken, phoneNumberId, recipient, templateName, templateLanguage, apiVersion];
  const configuredCount = values.filter((value) => typeof value === 'string' && value.length > 0).length;

  if (configuredCount === 0) return null;
  if (configuredCount !== values.length) {
    throw new Error('Configure all WhatsApp Cloud API environment variables or leave them all unset.');
  }
  if (!/^\d{5,30}$/.test(phoneNumberId) || !/^\d{8,15}$/.test(recipient) ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(templateName) ||
      !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(templateLanguage) ||
      !/^v\d+\.\d+$/.test(apiVersion)) {
    throw new Error('WhatsApp Cloud API configuration is invalid.');
  }

  return async function sendWhatsAppPermitAlert(permit) {
    const statusText = permit.alert_type === 'expired' ? 'منتهي' : 'ينتهي خلال 30 يوماً';
    const response = await fetchImpl(
      `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + accessToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: recipient,
          type: 'template',
          template: {
            name: templateName,
            language: { code: templateLanguage },
            components: [{
              type: 'body',
              parameters: [
                { type: 'text', text: permit.permit_number },
                { type: 'text', text: permit.vehicle_plate },
                { type: 'text', text: permit.valid_until },
                { type: 'text', text: statusText }
              ]
            }]
          }
        })
      }
    );
    if (!response.ok) throw new Error(`WhatsApp delivery failed with status ${response.status}.`);
  };
}

function createPermitAlertRunner({ db, sendAlert, now = () => new Date() }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS permit_alert_deliveries (
      id INTEGER PRIMARY KEY,
      permit_id INTEGER NOT NULL REFERENCES vehicle_permits(id),
      alert_type TEXT NOT NULL CHECK (alert_type IN ('expiring', 'expired')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      sent_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (permit_id, alert_type)
    );
  `);

  let running;
  return async function sendDuePermitAlerts() {
    if (!sendAlert) return { disabled: true, sent: 0 };
    if (running) return running;
    running = runDueAlerts();
    try {
      return await running;
    } finally {
      running = undefined;
    }
  };

  async function runDueAlerts() {
    const currentDate = now().toISOString().slice(0, 10);
    const datePlusThirty = new Date(`${currentDate}T00:00:00.000Z`);
    datePlusThirty.setUTCDate(datePlusThirty.getUTCDate() + 30);
    const expiringThrough = datePlusThirty.toISOString().slice(0, 10);

    db.prepare(`
      INSERT OR IGNORE INTO permit_alert_deliveries (permit_id, alert_type)
      SELECT id, 'expiring' FROM vehicle_permits
      WHERE valid_from <= ? AND valid_until >= ? AND valid_until <= ?
    `).run(currentDate, currentDate, expiringThrough);
    db.prepare(`
      INSERT OR IGNORE INTO permit_alert_deliveries (permit_id, alert_type)
      SELECT id, 'expired' FROM vehicle_permits WHERE valid_until < ?
    `).run(currentDate);

    const pending = db.prepare(`
      SELECT d.id AS delivery_id, d.alert_type, p.permit_number, p.vehicle_plate, p.valid_until
      FROM permit_alert_deliveries d
      JOIN vehicle_permits p ON p.id = d.permit_id
      WHERE d.sent_at IS NULL
        AND (d.last_attempt_at IS NULL OR d.last_attempt_at <= datetime(?, '-55 minutes'))
      ORDER BY d.id
      LIMIT 20
    `).all(now().toISOString().replace('T', ' ').slice(0, 19));
    let sent = 0;
    for (const alert of pending) {
      db.prepare(`
        UPDATE permit_alert_deliveries
        SET attempt_count = attempt_count + 1, last_attempt_at = ?
        WHERE id = ? AND sent_at IS NULL
      `).run(now().toISOString().replace('T', ' ').slice(0, 19), alert.delivery_id);
      try {
        await sendAlert(alert);
        db.prepare('UPDATE permit_alert_deliveries SET sent_at = ? WHERE id = ? AND sent_at IS NULL')
          .run(now().toISOString().replace('T', ' ').slice(0, 19), alert.delivery_id);
        sent += 1;
      } catch (error) {
        console.error(`WhatsApp permit alert delivery failed for delivery ${alert.delivery_id}:`, error.message);
      }
    }
    return { disabled: false, sent, pending: pending.length - sent };
  }
}

module.exports = { createWhatsAppSender, createPermitAlertRunner };
