/**
 * AWS Lambda Handler
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
 * Lambda Handler
 */
exports.handler = async (event, context) => {
  try {
    const fastify = await initServer();

    // Parse API Gateway event
    const { httpMethod, path, queryStringParameters, headers, body, isBase64Encoded } = event;

    // Build URL
    let url = path;
    if (queryStringParameters) {
      const params = new URLSearchParams(queryStringParameters).toString();
      url += '?' + params;
    }

    // Decode body if base64
    let payload = body;
    if (isBase64Encoded && body) {
      payload = Buffer.from(body, 'base64').toString('utf-8');
    }

    // Convert to Fastify request
    const response = await fastify.inject({
      method: httpMethod,
      url: url,
      headers: headers || {},
      payload: payload,
    });

    // Return API Gateway response format
    return {
      isBase64Encoded: false,
      statusCode: response.statusCode,
      headers: {
        'Content-Type': response.headers['content-type'] || 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
      },
      body: response.body,
    };
  } catch (error) {
    console.error('Handler error:', error);
    return {
      isBase64Encoded: false,
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error (see server logs)'
        }
      }),
    };
  }
};
