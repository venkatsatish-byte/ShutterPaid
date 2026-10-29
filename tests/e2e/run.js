// Runs every browser test file. Usage: npm run test:e2e
const { finish } = require('./harness');
(async () => {
  for (const file of ['./app.e2e.js', './reminders.e2e.js', './billing.e2e.js', './site.e2e.js', './payments.e2e.js', './booking-setup.e2e.js']) {
    console.log('\n# ' + file);
    await require(file)();
  }
  process.exit(finish() ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
