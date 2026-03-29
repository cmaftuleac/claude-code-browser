/**
 * Chrome Native Messaging I/O.
 * Protocol: 4-byte little-endian uint32 length prefix + UTF-8 JSON payload.
 * Max message size: 1MB (Chrome limit).
 * stdout = messages to extension, stderr = logging.
 */

export function writeNativeMessage(msg: unknown): void {
  const json = JSON.stringify(msg);
  const buf = Buffer.from(json, 'utf-8');
  if (buf.length > 1024 * 1024) {
    log('WARNING: Message exceeds 1MB Chrome limit, truncating');
    return;
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(buf.length, 0);
  process.stdout.write(header);
  process.stdout.write(buf);
}

export function readNativeMessage(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    readBytes(4)
      .then((header) => {
        const len = header.readUInt32LE(0);
        return readBytes(len);
      })
      .then((body) => {
        resolve(JSON.parse(body.toString('utf-8')));
      })
      .catch(reject);
  });
}

function readBytes(count: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;

    function tryRead() {
      while (received < count) {
        const remaining = count - received;
        const chunk = process.stdin.read(remaining) as Buffer | null;
        if (!chunk) {
          process.stdin.once('readable', tryRead);
          return;
        }
        chunks.push(chunk);
        received += chunk.length;
      }
      resolve(Buffer.concat(chunks));
    }

    process.stdin.once('end', () => reject(new Error('EOF')));
    process.stdin.once('error', reject);
    tryRead();
  });
}

export function log(...args: unknown[]): void {
  process.stderr.write('[ccb-host] ' + args.map(String).join(' ') + '\n');
}
