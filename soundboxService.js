/**
 * 🔊 Real-Time MQTT Order Announcement Soundbox Service
 * 
 * Communicates with ESP32-S3 Soundboxes located at shop counters.
 * Publishes announcements when orders are placed or parchis are submitted.
 * 
 * - Default Broker: mqtt://broker.hivemq.com:1883
 * - Topic Pattern: antiproject/soundbox/shops/{shopId}
 * - Auto-reconnect: Every 3000ms
 * - Fully Non-blocking: Checkout flows NEVER fail or freeze if MQTT has network issues.
 */

const mqtt = require('mqtt');

const DEFAULT_BROKER_URL = 'mqtt://broker.hivemq.com:1883';
const DEFAULT_TOPIC_PREFIX = 'antiproject/soundbox/shops';

const brokerUrl = process.env.MQTT_BROKER_URL || DEFAULT_BROKER_URL;
const topicPrefix = (process.env.MQTT_TOPIC_PREFIX || DEFAULT_TOPIC_PREFIX).replace(/\/+$/, '');

const mqttOptions = {
  reconnectPeriod: 3000,
  connectTimeout: 30000,
  clean: true,
  clientId: `packitout_api_${Math.random().toString(16).slice(2, 10)}`,
};

// Add credentials if configured for HiveMQ Cloud or private broker
if (process.env.MQTT_USERNAME && process.env.MQTT_USERNAME.trim()) {
  mqttOptions.username = process.env.MQTT_USERNAME.trim();
  mqttOptions.password = process.env.MQTT_PASSWORD ? process.env.MQTT_PASSWORD.trim() : '';
}

let client = null;
let isConnected = false;

function initClient() {
  if (client) return client;

  try {
    console.log(`[Soundbox MQTT] Initializing connection to ${brokerUrl}...`);
    client = mqtt.connect(brokerUrl, mqttOptions);

    client.on('connect', () => {
      isConnected = true;
      console.log(`[Soundbox MQTT] Connected successfully to ${brokerUrl}`);
    });

    client.on('reconnect', () => {
      console.log('[Soundbox MQTT] Reconnecting to MQTT broker...');
    });

    client.on('close', () => {
      isConnected = false;
    });

    client.on('offline', () => {
      isConnected = false;
      console.warn('[Soundbox MQTT] Client is offline.');
    });

    client.on('error', (err) => {
      console.error('[Soundbox MQTT] Connection error:', err.message);
    });
  } catch (err) {
    console.error('[Soundbox MQTT] Initialization failure:', err.message);
  }

  return client;
}

// Start singleton client immediately
initClient();

/**
 * Publish raw payload to topic with a timeout so it never blocks.
 * @param {string} topic
 * @param {object} payload
 * @returns {Promise<boolean>}
 */
function publishMessage(topic, payload) {
  return new Promise((resolve) => {
    try {
      if (!client) {
        console.warn('[Soundbox MQTT] Client not initialized, skipping publish.');
        return resolve(false);
      }

      const messageStr = JSON.stringify(payload);
      const publishTimeout = setTimeout(() => {
        console.warn(`[Soundbox MQTT] Publish timeout (5s) on ${topic}`);
        resolve(false);
      }, 5000);

      client.publish(topic, messageStr, { qos: 1 }, (err) => {
        clearTimeout(publishTimeout);
        if (err) {
          console.error(`[Soundbox MQTT] Failed to publish on ${topic}:`, err.message);
          return resolve(false);
        }
        console.log(`[Soundbox MQTT] Published to ${topic}:`, messageStr);
        resolve(true);
      });
    } catch (err) {
      console.error(`[Soundbox MQTT] Unexpected publish error:`, err.message);
      resolve(false);
    }
  });
}

/**
 * 🛒 Notify Soundbox of a New Order
 * 
 * Payload Schema:
 * {
 *   "type": "order",
 *   "orderId": "ORD-ABC12",
 *   "shopId": "69c49f8a0828eacc3bb49b4c",
 *   "amount": 350,
 *   "itemCount": 3,
 *   "totalQuantity": 5,
 *   "currency": "rupees",
 *   "paymentMethod": "POP"
 * }
 */
async function notifySoundbox({ shopId, amount, itemCount, totalQuantity, orderId, paymentMethod }) {
  if (!shopId) {
    console.warn('[Soundbox MQTT] Cannot notify: missing shopId.');
    return false;
  }

  const cleanShopId = String(shopId);
  const topic = `${topicPrefix}/${cleanShopId}`;

  const payload = {
    type: "order",
    orderId: String(orderId || ""),
    shopId: cleanShopId,
    amount: Math.round(Number(amount || 0)),
    itemCount: Number(itemCount !== undefined ? itemCount : 1),
    totalQuantity: Number(totalQuantity !== undefined ? totalQuantity : (itemCount || 1)),
    currency: "rupees",
    paymentMethod: String(paymentMethod || "POP")
  };

  return await publishMessage(topic, payload);
}

/**
 * 📝 Notify Soundbox of a New Parchi (Handwritten Shopping List)
 * 
 * Payload Schema:
 * {
 *   "type": "parchi",
 *   "shopId": "69c49f8a0828eacc3bb49b4c",
 *   "parchiId": "65f...",
 *   "customerName": "Customer",
 *   "message": "New shopping list received"
 * }
 */
async function notifyParchiSoundbox({ shopId, customerName, parchiId }) {
  if (!shopId) {
    console.warn('[Soundbox MQTT] Cannot notify parchi: missing shopId.');
    return false;
  }

  const cleanShopId = String(shopId);
  const topic = `${topicPrefix}/${cleanShopId}`;

  const payload = {
    type: "parchi",
    shopId: cleanShopId,
    parchiId: String(parchiId || ""),
    customerName: String(customerName || "Customer"),
    message: "New shopping list received"
  };

  return await publishMessage(topic, payload);
}

/**
 * 🏬 Multi-Shop Order Notification Handler
 * Loops through multiple shop orders and notifies each shop's soundbox independently.
 * @param {Array<{shopId, amount, itemCount, totalQuantity, orderId, paymentMethod}>} orders
 */
async function notifyMultiShopSoundboxes(orders = []) {
  if (!Array.isArray(orders) || orders.length === 0) return [];
  return await Promise.allSettled(orders.map((o) => notifySoundbox(o)));
}

/**
 * 🔍 Inspect connection status for diagnostics
 */
function getSoundboxClientStatus() {
  return {
    connected: isConnected,
    brokerUrl,
    topicPrefix,
    clientId: mqttOptions.clientId,
  };
}

module.exports = {
  notifySoundbox,
  notifyParchiSoundbox,
  notifyMultiShopSoundboxes,
  getSoundboxClientStatus,
  publishMessage,
  initClient,
};
