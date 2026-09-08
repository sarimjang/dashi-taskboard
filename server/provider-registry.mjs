// @ts-check

/**
 * @typedef {"none" | "read" | "read-write"} ProviderAccessLevel
 */

/**
 * Explicit provider capability declaration. Replaces `source === "jira"` literal
 * comparisons scattered across route handlers, the database mapper, and frontend
 * components. See openspec/changes/provider-contract-abstraction/design.md Decisions.
 *
 * @typedef {object} ProviderCapabilities
 * @property {boolean} createIssue
 * @property {boolean} updateAssignee
 * @property {ProviderAccessLevel} comments
 * @property {ProviderAccessLevel} attachments
 * @property {ProviderAccessLevel} relations
 * @property {boolean} webhook
 * @property {boolean} incrementalSync
 * @property {boolean} manualArchive
 * @property {boolean} manualDelete
 * @property {boolean} manualMove
 * @property {boolean} assigneeEdit
 * @property {boolean} projectReassign
 */

/**
 * @typedef {object} RegisteredProvider
 * @property {ProviderCapabilities} capabilities
 */

/**
 * Local tasks/projects have no external provider constraining them, so every
 * mutation capability is granted.
 *
 * @type {ProviderCapabilities}
 */
const LOCAL_DEFAULT_CAPABILITIES = Object.freeze({
  createIssue: true,
  updateAssignee: true,
  comments: "read-write",
  attachments: "read-write",
  relations: "read-write",
  webhook: true,
  incrementalSync: true,
  manualArchive: true,
  manualDelete: true,
  manualMove: true,
  assigneeEdit: true,
  projectReassign: true,
});

/** @type {Map<string, RegisteredProvider>} */
const registry = new Map();

/**
 * @param {string} source
 * @param {RegisteredProvider} provider
 */
export function registerProvider(source, provider) {
  registry.set(source, provider);
}

/**
 * @param {string | null} source
 * @returns {RegisteredProvider | null}
 */
export function getProvider(source) {
  if (source === null) return null;
  return registry.get(source) ?? null;
}

/**
 * @param {string | null} source
 * @returns {ProviderCapabilities}
 */
export function getProviderCapabilities(source) {
  const provider = getProvider(source);
  return provider ? provider.capabilities : LOCAL_DEFAULT_CAPABILITIES;
}
