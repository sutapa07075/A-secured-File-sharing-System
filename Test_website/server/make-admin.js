// One-off CLI helper: promote an existing user (who already registered normally,
// via email/password or Google/GitHub) to the admin role.
//
// Usage:
//   node make-admin.js someone@example.com
require('dotenv').config();
const db = require('./db');

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: node make-admin.js <email>');
    process.exit(1);
  }

  await db.schemaReady;
  const user = await db.get('SELECT id, email, role FROM users WHERE email = ?', [email.toLowerCase()]);
  if (!user) {
    console.error(`No user found with email ${email}. Ask them to register first, then run this again.`);
    process.exit(1);
  }

  await db.run('UPDATE users SET role = ? WHERE id = ?', ['admin', user.id]);
  console.log(`${user.email} is now an admin.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
