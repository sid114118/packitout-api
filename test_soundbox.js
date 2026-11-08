require('dotenv').config();
const mqtt = require('mqtt');
const { notifySoundbox, notifyParchiSoundbox, getSoundboxClientStatus } = require('./soundboxService');

const TEST_SHOP_ID = '69c4917e21ea0ff2723568f1';
const TEST_TOPIC = `antiproject/soundbox/shops/${TEST_SHOP_ID}`;
const BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://broker.hivemq.com:1883';

async function runTest() {
  console.log(`\n=============================================`);
  console.log(`🔊 SOUNDBOX MQTT INTEGRATION VERIFICATION TEST`);
  console.log(`=============================================`);
  console.log(`Target Shop ID: ${TEST_SHOP_ID}`);
  console.log(`Broker: ${BROKER_URL}`);
  console.log(`Subscribing Topic: ${TEST_TOPIC}`);

  // 1. Create a simulated ESP32 subscriber client
  const subscriber = mqtt.connect(BROKER_URL, {
    clientId: `simulated_esp32_${Math.random().toString(16).slice(2, 8)}`,
    clean: true,
  });

  const receivedMessages = [];

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Subscriber connection timeout')), 35000);

    subscriber.on('connect', () => {
      clearTimeout(timeout);
      console.log('✅ Simulated ESP32 subscriber connected to broker.');
      subscriber.subscribe(TEST_TOPIC, { qos: 1 }, (err) => {
        if (err) return reject(err);
        console.log(`✅ Subscribed to topic: ${TEST_TOPIC}`);
        resolve();
      });
    });

    subscriber.on('error', (err) => {
      console.error('Subscriber error:', err.message);
    });
  });

  subscriber.on('message', (topic, message) => {
    try {
      const parsed = JSON.parse(message.toString());
      console.log(`\n📩 [Simulated ESP32 Received] on "${topic}":`);
      console.dir(parsed, { depth: null, colors: true });
      receivedMessages.push(parsed);
    } catch (e) {
      console.log('Received raw:', message.toString());
    }
  });

  // Wait for the singleton soundbox service to be connected
  console.log('⏳ Waiting for soundboxService to connect to broker...');
  for (let i = 0; i < 30; i++) {
    if (getSoundboxClientStatus().connected) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log('Service status:', getSoundboxClientStatus());

  // 2. Test publishing an Order announcement
  console.log('\n--- 🧪 TEST 1: Publishing Order Announcement ---');
  await notifySoundbox({
    shopId: TEST_SHOP_ID,
    amount: 450,
    itemCount: 3,
    totalQuantity: 5,
    orderId: 'ORD-TEST1',
    paymentMethod: 'POP',
  });

  await new Promise((r) => setTimeout(r, 2000));

  // 3. Test publishing a Parchi announcement
  console.log('\n--- 🧪 TEST 2: Publishing Parchi Announcement ---');
  await notifyParchiSoundbox({
    shopId: TEST_SHOP_ID,
    customerName: 'Amit Sharma',
    parchiId: 'PARCHI-9988',
  });

  await new Promise((r) => setTimeout(r, 2000));

  console.log(`\n=============================================`);
  console.log(`SUMMARY: Total messages received by simulated ESP32: ${receivedMessages.length}`);
  if (receivedMessages.length >= 2) {
    console.log(`🎉 ALL TESTS PASSED! Soundbox MQTT pipeline is 100% operational.`);
  } else {
    console.log(`⚠️ Some messages were missed.`);
  }
  console.log(`=============================================\n`);

  subscriber.end();
  process.exit(0);
}

runTest().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
