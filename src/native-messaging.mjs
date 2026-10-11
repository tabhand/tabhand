import os from 'node:os';

// Chrome native messaging frames every message as a 4-byte length (native byte order) + UTF-8 JSON.
const LE = os.endianness() === 'LE';

/** Calls onMessage for every complete message read from the stream. */
export function readMessages(stream, onMessage) {
  let buffer = Buffer.alloc(0);
  stream.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = LE ? buffer.readUInt32LE(0) : buffer.readUInt32BE(0);
      if (buffer.length < 4 + length) break;
      const body = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      let message;
      try {
        message = JSON.parse(body.toString('utf8'));
      } catch {
        continue;
      }
      onMessage(message);
    }
  });
}

export function writeMessage(stream, message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  if (LE) header.writeUInt32LE(body.length, 0);
  else header.writeUInt32BE(body.length, 0);
  stream.write(Buffer.concat([header, body]));
}
