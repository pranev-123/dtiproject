#!/usr/bin/env node
/**
 * Generate self-signed TLS certificates for HTTPS (port 3443).
 * Run once: node scripts/generate-certs.js
 * Certificates are written to certs/key.pem and certs/cert.pem.
 */
const fs = require('fs');
const path = require('path');
const selfsigned = require('selfsigned');

const certsDir = path.join(__dirname, '..', 'certs');
const keyPath = path.join(certsDir, 'key.pem');
const certPath = path.join(certsDir, 'cert.pem');

async function main() {
  if (!fs.existsSync(certsDir)) {
    fs.mkdirSync(certsDir, { recursive: true });
  }
  const pems = await selfsigned.generate(
    [{ name: 'commonName', value: 'localhost' }],
    { days: 365, keySize: 2048, algorithm: 'sha256' }
  );
  fs.writeFileSync(keyPath, pems.private, 'utf8');
  fs.writeFileSync(certPath, pems.cert, 'utf8');
  console.log('Generated certs/key.pem and certs/cert.pem (valid 365 days).');
  console.log('HTTPS server will listen on port 3443 when you start the server.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
