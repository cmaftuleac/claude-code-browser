import http from 'node:http';

const PORT = 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, path: req.url, ts: new Date().toISOString() }));
});

server.listen(PORT, () => {
  console.log(`listening on http://localhost:${PORT}`);
});
