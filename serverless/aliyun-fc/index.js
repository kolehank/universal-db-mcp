/**
 * Aliyun Function Compute Handler
 * Adapter for Universal Database MCP Server
 */

const { createHttpServer } = require('../../dist/http/server.js');
const { loadConfig } = require('../../dist/utils/config-loader.js');

let server;

/**
 * Initialize server (lazy loading)
 */
async function initServer() {
  if (!server) {
    const config = loadConfig();
    server = await createHttpServer(config);
  }
  return server;
}

/**
 * Function Compute HTTP Handler
 */
exports.handler = async (req, resp, context) => {
  try {
    const fastify = await initServer();

    // Convert FC request to Fastify request format
    const response = await fastify.inject({
      method: req.method,
      url: req.path + (req.queries ? '?' + new URLSearchParams(req.queries).toString() : ''),
      headers: req.headers,
      payload: req.body,
    });

    // Set response
    resp.setStatusCode(response.statusCode);
    resp.setHeader('Content-Type', response.headers['content-type'] || 'application/json');

    // Set CORS headers
    resp.setHeader('Access-Control-Allow-Origin', '*');
    resp.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    resp.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');

    resp.send(response.body);
  } catch (error) {
    console.error('Handler error:', error);
    resp.setStatusCode(500);
    resp.send(JSON.stringify({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error (see server logs)'
      }
    }));
  }
};
