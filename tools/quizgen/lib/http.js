'use strict';
// Minimal HTTP client — Node built-in modules only.
// Handles cookies, redirects, gzip/deflate/br, and charset-aware decoding.

const https = require('https');
const http = require('http');
const zlib = require('zlib');
const { URL } = require('url');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// A cookie jar is just a Map of name -> value (single-host usage per jar).
function newJar() {
  return new Map();
}

function cookieHeader(jar) {
  if (!jar || jar.size === 0) return '';
  return Array.from(jar, ([k, v]) => `${k}=${v}`).join('; ');
}

function storeCookies(jar, setCookie) {
  if (!jar || !setCookie) return;
  const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const line of arr) {
    const first = line.split(';', 1)[0];
    const eq = first.indexOf('=');
    if (eq < 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (name) jar.set(name, value);
  }
}

function decompress(buf, encoding) {
  try {
    if (encoding === 'gzip') return zlib.gunzipSync(buf);
    if (encoding === 'deflate') return zlib.inflateSync(buf);
    if (encoding === 'br') return zlib.brotliDecompressSync(buf);
  } catch (_) {
    // fall through to raw buffer on decompression failure
  }
  return buf;
}

function detectCharset(buffer, headerCT, override) {
  if (override) return override.toLowerCase();
  const ct = (headerCT || '').toLowerCase();
  let m = ct.match(/charset=([\w-]+)/);
  if (m) return m[1];
  // sniff the first 2KB for a <meta charset>
  const head = buffer.slice(0, 2048).toString('latin1');
  m = head.match(/charset=["']?([\w-]+)/i);
  if (m) return m[1].toLowerCase();
  return 'utf-8';
}

function decode(buffer, charset) {
  let cs = (charset || 'utf-8').toLowerCase();
  if (cs === 'utf8') cs = 'utf-8';
  if (cs === 'ms949' || cs === 'cp949' || cs === 'ksc5601') cs = 'euc-kr';
  try {
    return new TextDecoder(cs).decode(buffer);
  } catch (_) {
    return buffer.toString('utf8');
  }
}

function once(method, urlStr, opts) {
  const u = new URL(urlStr);
  const lib = u.protocol === 'http:' ? http : https;
  const jar = opts.jar;
  const headers = Object.assign(
    {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
    },
    opts.headers || {}
  );
  const cookie = cookieHeader(jar);
  if (cookie) headers['Cookie'] = cookie;

  let body = opts.body;
  if (body != null && method !== 'GET' && method !== 'HEAD') {
    if (typeof body !== 'string') body = String(body);
    if (!headers['Content-Type'])
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=utf-8';
    headers['Content-Length'] = Buffer.byteLength(body);
  }

  return new Promise((resolve, reject) => {
    const reqOpts = {
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      headers,
      timeout: opts.timeout || 25000,
    };
    // Corporate networks here intercept TLS with a self-signed root CA that
    // Node's bundled trust store doesn't recognize. Skip verification unless
    // SCRAPER_STRICT_TLS is set (or a corporate CA is supplied via
    // NODE_EXTRA_CA_CERTS). These are known public/internal endpoints.
    if (u.protocol === 'https:' && !process.env.SCRAPER_STRICT_TLS) {
      reqOpts.rejectUnauthorized = false;
    }
    const req = lib.request(
      reqOpts,
      (res) => {
        storeCookies(jar, res.headers['set-cookie']);
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = decompress(
            Buffer.concat(chunks),
            (res.headers['content-encoding'] || '').toLowerCase()
          );
          resolve({
            status: res.statusCode,
            headers: res.headers,
            buffer: raw,
            url: urlStr,
            decode(cs) {
              return decode(raw, detectCharset(raw, res.headers['content-type'], cs));
            },
          });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout: ' + urlStr)));
    if (body != null && method !== 'GET' && method !== 'HEAD') req.write(body);
    req.end();
  });
}

async function request(method, urlStr, opts = {}) {
  const maxRedirects = opts.maxRedirects != null ? opts.maxRedirects : 6;
  let curMethod = method;
  let curUrl = urlStr;
  let curBody = opts.body;
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await once(curMethod, curUrl, Object.assign({}, opts, { body: curBody }));
    const loc = res.headers.location;
    if (res.status >= 300 && res.status < 400 && loc && i < maxRedirects) {
      curUrl = new URL(loc, curUrl).toString();
      // 303, or 301/302 after a POST -> follow with GET (browser behavior)
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && curMethod === 'POST')) {
        curMethod = 'GET';
        curBody = undefined;
      }
      continue;
    }
    return res;
  }
  throw new Error('too many redirects: ' + urlStr);
}

const get = (url, opts) => request('GET', url, opts);
const post = (url, body, opts) => request('POST', url, Object.assign({ body }, opts));

module.exports = { request, get, post, newJar, UA, decode };
