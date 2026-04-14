/**
 * toolHooks.js — Phase 2 stub
 *
 * All methods are no-ops in Phase 1. Phase 2 will implement secondary model
 * tool calling (NemosGuides-style): the main model can call tools mid-generation,
 * each tool triggers a sidecar API call to settings.secondaryModel, and results
 * are injected back into context (ephemerally or persistently).
 */

export default {
  /**
   * Called before sending assembled messages to the provider.
   * Phase 2: inject tool definitions into messages, route via connection pool.
   * @param {Array} messages
   * @param {Object} settings
   * @returns {Promise<Array>} messages (possibly modified)
   */
  processRequest: async (messages, _settings) => messages,

  /**
   * Called as each token arrives during streaming.
   * Phase 2: detect tool call syntax mid-stream, buffer for sidecar dispatch.
   * @param {string} token
   * @param {Object} context
   */
  onToken: (_token, _context) => {},

  /**
   * Called when stream ends with the full accumulated assistant content.
   * Phase 2: parse completed tool calls, execute sidecar calls to secondary model,
   * inject results ephemerally or store persistently.
   * @param {string} content
   * @param {Object} context
   * @returns {Promise<null>}
   */
  onStreamEnd: async (_content, _context) => null,

  /**
   * Called when a stream begins.
   * Phase 2: initialize tool call accumulation buffer.
   * @param {Object} context
   */
  onStreamStart: (_context) => {},
};
