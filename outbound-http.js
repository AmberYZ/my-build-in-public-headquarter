/**
 * Shared outbound HTTP(S) options for axios when HTTPS_PROXY / ALL_PROXY is SOCKS.
 * Axios treats SOCKS env as HTTP proxy otherwise → "protocol mismatch" errors.
 */
const { SocksProxyAgent } = require('socks-proxy-agent');

const outboundProxy =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy ||
  process.env.ALL_PROXY ||
  process.env.all_proxy ||
  '';

let socksAgent = null;
if (outboundProxy && /^socks/i.test(outboundProxy)) {
  const proxyUrl = outboundProxy.replace(/^socks5:\/\//i, 'socks5h://');
  socksAgent = new SocksProxyAgent(proxyUrl);
}

/** Merge axios request options with SOCKS agent when applicable (same as ai-provider netOpts). */
function socksAxiosOptions(opts) {
  if (!socksAgent) return opts || {};
  return {
    ...(opts || {}),
    proxy: false,
    httpAgent: socksAgent,
    httpsAgent: socksAgent
  };
}

module.exports = { socksAxiosOptions };
